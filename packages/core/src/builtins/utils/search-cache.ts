import { recordSourceSearch } from '../../utils/source-search.js';

type Cache<T> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttl: number, force?: boolean): Promise<void>;
};
type Options<T> = {
  key: string;
  cache: Cache<T>;
  ttl: number;
  emptyTTL: number;
  refreshInterval: number;
  isEmpty: (value: T) => boolean;
  fetch: () => Promise<T>;
  refreshState: Cache<{ until: number; failures: number }>;
  now?: () => number;
};
const pending = new Map<string, Promise<unknown>>();

async function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = pending.get(key);
  if (existing) {
    recordSourceSearch('coalesced');
    return existing as Promise<T>;
  }
  if (pending.size >= 2048)
    throw new Error('Search coalescing capacity reached');
  // Reserve synchronously before the first asynchronous cache/state read.
  const promise = Promise.resolve().then(fn);
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(key) === promise) pending.delete(key);
  }
}

export async function cachedSourceSearch<T>(o: Options<T>): Promise<T> {
  const now = o.now ?? Date.now;
  const cached = await o.cache.get(o.key);
  const fetch = () =>
    singleFlight(o.key, async () => {
      const state = await o.refreshState.get(o.key);
      if (state && state.until > now())
        throw new Error('Source search temporarily backing off');
      // Claim refresh cooldown before fetching, including empty/error results.
      await o.refreshState.set(
        o.key,
        {
          until: now() + o.refreshInterval * 1000,
          failures: state?.failures ?? 0,
        },
        Math.max(o.refreshInterval, 86400)
      );
      try {
        const fresh = await o.fetch();
        if (!o.isEmpty(fresh) || cached === undefined) {
          await o.cache.set(
            o.key,
            fresh,
            o.isEmpty(fresh) ? o.emptyTTL : o.ttl,
            true
          );
        }
        await o.refreshState.set(
          o.key,
          { until: now() + o.refreshInterval * 1000, failures: 0 },
          Math.max(o.refreshInterval, 86400)
        );
        return fresh;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          await o.refreshState.set(
            o.key,
            { until: 0, failures: state?.failures ?? 0 },
            86400
          );
          throw error;
        }
        const failures = (state?.failures ?? 0) + 1;
        const seconds = [15, 60, 300, 900][Math.min(failures - 1, 3)];
        await o.refreshState.set(
          o.key,
          { until: now() + seconds * 1000, failures },
          86400
        );
        throw error;
      }
    });
  if (cached !== undefined) {
    recordSourceSearch(o.isEmpty(cached) ? 'negativeHits' : 'cacheHits');
    if (!o.isEmpty(cached)) {
      const state = await o.refreshState.get(o.key);
      if (!state || state.until <= now()) {
        recordSourceSearch('background');
        void fetch().catch(() => {}); // Keep the good result; diagnostics count attempts separately.
      }
    }
    return cached;
  }
  // Negative result expiry is deliberately shorter than positive refresh TTL.
  // Successful refresh state must not block a cold/expired cache entry.
  const state = await o.refreshState.get(o.key);
  if (state?.failures && state.until > now())
    throw new Error('Source search temporarily backing off');
  return singleFlight(o.key, async () => {
    const check = await o.cache.get(o.key);
    if (check !== undefined) return check;
    // A successful previous timestamp isn't a failure cooldown on cache miss.
    const previous = await o.refreshState.get(o.key);
    if (previous?.failures && previous.until > now())
      throw new Error('Source search temporarily backing off');
    await o.refreshState.set(
      o.key,
      { until: 0, failures: previous?.failures ?? 0 },
      86400
    );
    // Inline fetch to avoid recursively awaiting this same single-flight promise.
    try {
      const value = await o.fetch();
      await o.cache.set(
        o.key,
        value,
        o.isEmpty(value) ? o.emptyTTL : o.ttl,
        true
      );
      await o.refreshState.set(
        o.key,
        { until: now() + o.refreshInterval * 1000, failures: 0 },
        Math.max(o.refreshInterval, 86400)
      );
      return value;
    } catch (error) {
      const cancelled = error instanceof Error && error.name === 'AbortError';
      const failures = cancelled
        ? (previous?.failures ?? 0)
        : (previous?.failures ?? 0) + 1;
      const seconds = cancelled
        ? 0
        : [15, 60, 300, 900][Math.min(failures - 1, 3)];
      await o.refreshState.set(
        o.key,
        { until: now() + seconds * 1000, failures },
        86400
      );
      throw error;
    }
  });
}
