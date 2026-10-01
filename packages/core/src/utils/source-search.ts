import { AsyncLocalStorage } from 'node:async_hooks';

export type SourceSearchContext = {
  maintenance: boolean;
  signal?: AbortSignal;
};
export const sourceSearchContext = new AsyncLocalStorage<SourceSearchContext>();
const counters = {
  submitted: 0,
  completed: 0,
  cancelled: 0,
  queueExpired: 0,
  cacheHits: 0,
  negativeHits: 0,
  coalesced: 0,
  background: 0,
  queueMilliseconds: 0,
  sourceMilliseconds: 0,
  seasonReused: 0,
  episodeFallbacks: 0,
};
export const recordSourceSearch = (name: keyof typeof counters, amount = 1) => {
  counters[name] += amount;
};

type Work = {
  maintenance: boolean;
  run: () => void;
  reject: (error: Error) => void;
};
export class SourceSearchScheduler {
  active = 0;
  private queue: Work[] = [];
  private foregroundClaims = 0;
  constructor(
    public concurrency: number,
    private maxQueued = 256
  ) {}
  get queued() {
    return this.queue.length;
  }
  schedule<T>(
    fn: () => Promise<T>,
    context: SourceSearchContext = { maintenance: false },
    waitMs = 25_000
  ): Promise<T> {
    if (context.signal?.aborted)
      return Promise.reject(new DOMException('Request ended', 'AbortError'));
    if (this.queue.length >= this.maxQueued)
      return Promise.reject(new Error('Source search queue full'));
    const start = Date.now();
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const clean = () => {
        if (timer) clearTimeout(timer);
        context.signal?.removeEventListener('abort', abort);
      };
      const remove = (error: Error) => {
        this.queue = this.queue.filter((x) => x !== work);
        clean();
        reject(error);
      };
      const abort = () => {
        recordSourceSearch('cancelled');
        remove(new DOMException('Request ended', 'AbortError'));
      };
      const work: Work = {
        maintenance: context.maintenance,
        reject: remove,
        run: () => {
          clean();
          this.active++;
          recordSourceSearch('queueMilliseconds', Date.now() - start);
          recordSourceSearch('submitted');
          const sourceStart = Date.now();
          // drain() may run in the previous request's async context. Restore the
          // queued caller's cancellation/lane context before its transport runs.
          Promise.resolve()
            .then(() => sourceSearchContext.run(context, fn))
            .then(resolve, reject)
            .finally(() => {
              recordSourceSearch(
                'sourceMilliseconds',
                Date.now() - sourceStart
              );
              recordSourceSearch('completed');
              this.active--;
              this.drain();
            });
        },
      };
      timer = setTimeout(() => {
        recordSourceSearch('queueExpired');
        remove(new Error('Source search queue deadline'));
      }, waitMs);
      context.signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(work);
      this.drain();
    });
  }
  private drain() {
    while (this.active < Math.max(1, this.concurrency) && this.queue.length) {
      const foreground = this.queue.findIndex((x) => !x.maintenance);
      const background = this.queue.findIndex((x) => x.maintenance);
      const index =
        foreground >= 0 && (this.foregroundClaims < 8 || background < 0)
          ? foreground
          : Math.max(0, background);
      const work = this.queue.splice(index, 1)[0];
      this.foregroundClaims = work.maintenance ? 0 : this.foregroundClaims + 1;
      work.run();
    }
  }
}
const schedulers = new Map<string, SourceSearchScheduler>();
export function scheduleSourceSearch<T>(
  endpoint: string,
  concurrency: number,
  fn: () => Promise<T>
): Promise<T> {
  let scheduler = schedulers.get(endpoint);
  if (!scheduler) {
    if (schedulers.size >= 128)
      throw new Error('Source scheduler capacity reached');
    schedulers.set(
      endpoint,
      (scheduler = new SourceSearchScheduler(concurrency))
    );
  }
  scheduler.concurrency = concurrency;
  return scheduler.schedule(fn, sourceSearchContext.getStore(), 25_000);
}
export function sourceSearchMetrics() {
  return {
    ...counters,
    active: [...schedulers.values()].reduce((n, s) => n + s.active, 0),
    queued: [...schedulers.values()].reduce((n, s) => n + s.queued, 0),
    scope:
      'process-local Prowlarr search HTTP calls; other adapters and per-indexer fanout excluded',
  };
}
