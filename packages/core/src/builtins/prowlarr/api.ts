import { fetch } from 'undici';
import {
  Cache,
  createLogger,
  DistributedLock,
  formatZodError,
  makeRequest,
} from '../../utils/index.js';
import { config as appConfig } from '../../config/index.js';
import z from 'zod';
import { cachedSourceSearch } from '../utils/search-cache.js';
import {
  scheduleSourceSearch,
  sourceSearchContext,
} from '../../utils/source-search.js';
import { createHash } from 'node:crypto';

interface ResponseMeta {
  headers: Record<string, string>;
  status: number;
  statusText: string;
}

interface ProwlarrApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

interface ProwlarrConfig {
  baseUrl: string;
  apiKey: string;
  timeout: number;
}

export class ProwlarrApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string
  ) {
    super(message);
  }
}

const ProwlarrErrorSchema = z.object({
  message: z.string(),
  description: z.string(),
});

const ProwlarrApiTagItemSchema = z.object({
  label: z.string(),
  id: z.number(),
});
const ProwlarrApiTagsListSchema = z.array(ProwlarrApiTagItemSchema);
export type ProwlarrApiTagItem = z.infer<typeof ProwlarrApiTagItemSchema>;
// minimise schema to only include the fields we need
const ProwlarrApiIndexerSchema = z.object({
  id: z.number(),
  name: z.string(),
  sortName: z.string(),
  definitionName: z.string(),
  enable: z.boolean(),
  protocol: z.enum(['torrent', 'usenet']),
  tags: z.array(z.number()),
});

export type ProwlarrApiIndexer = z.infer<typeof ProwlarrApiIndexerSchema>;

const ProwlarrApiIndexersListSchema = z.array(ProwlarrApiIndexerSchema);

const ProwlarrApiSearchItemSchema = z.object({
  guid: z.string().optional(), // can sometimes be the raw magnet url
  age: z.number(), // in days
  size: z.number(),
  indexerId: z.number(),
  indexer: z.string(),
  title: z.string(),
  downloadUrl: z.url().optional(),
  indexerFlags: z.array(z.string()),
  magnetUrl: z.url().optional(),
  infoHash: z
    .string()
    .optional()
    .transform((val) => val?.toLowerCase()),
  seeders: z.number().optional(),
});

const ProwlarrApiSearchSchema = z.array(ProwlarrApiSearchItemSchema);

const logger = createLogger('prowlarr');

export type ProwlarrApiSearchItem = z.infer<typeof ProwlarrApiSearchItemSchema>;

class ProwlarrApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly cacheScope: string;
  private readonly refreshState = Cache.getInstance<
    string,
    { until: number; failures: number }
  >('prowlarr-api:refresh-state-v2', undefined, 'sql');

  private readonly baseApiPath = '/api/v1';

  private readonly searchCache = Cache.getInstance<
    string,
    ProwlarrApiResponse<ProwlarrApiSearchItem[]>
  >('prowlarr-api:search-v2', undefined, 'sql');

  private readonly indexersCache = Cache.getInstance<
    string,
    ProwlarrApiIndexer[]
  >('prowlarr-api:indexers');

  private readonly tagsCache = Cache.getInstance<string, ProwlarrApiTagItem[]>(
    'prowlarr-api:tags'
  );

  #headers: Record<string, string>;
  #timeout: number;

  constructor(config: ProwlarrConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.cacheScope = createHash('sha256')
      .update(JSON.stringify([this.baseUrl, this.apiKey]))
      .digest('hex');
    this.#headers = {
      'Content-Type': 'application/json',
      'X-Api-Key': this.apiKey,
      'User-Agent': appConfig.http.defaultUserAgent,
    };
    this.#timeout = config.timeout;
  }

  async tags(): Promise<ProwlarrApiResponse<ProwlarrApiTagItem[]>> {
    return this.tagsCache.wrap(
      () =>
        this.request<ProwlarrApiTagItem[]>(
          'tag',
          {},
          ProwlarrApiTagsListSchema
        ),
      `${this.cacheScope}:tag`,
      appConfig.builtins.prowlarr.indexersCacheTtl
    );
  }

  async indexers(): Promise<ProwlarrApiResponse<ProwlarrApiIndexer[]>> {
    return this.indexersCache.wrap(
      () =>
        this.request<ProwlarrApiIndexer[]>(
          'indexer',
          {},
          ProwlarrApiIndexersListSchema,
          3000
        ),
      `${this.cacheScope}:indexer`,
      appConfig.builtins.prowlarr.indexersCacheTtl
    );
  }

  async search({
    query,
    indexerIds,
    type,
    limit,
    offset,
  }: {
    query: string;
    indexerIds: number[];
    type: 'search';
    limit?: number;
    offset?: number;
  }): Promise<ProwlarrApiResponse<ProwlarrApiSearchItem[]>> {
    query = query.trim().replace(/\s+/g, ' ').toLowerCase();
    indexerIds = [...new Set(indexerIds)].sort((a, b) => a - b);
    const cacheKey = `${this.cacheScope}:${type}:${query}:${indexerIds.join(',')}:${limit}:${offset}`;

    return cachedSourceSearch({
      cache: this.searchCache,
      key: cacheKey,
      refreshState: this.refreshState,
      ttl: appConfig.builtins.prowlarr.searchCacheTtl,
      emptyTTL: 120,
      refreshInterval:
        appConfig.builtins.torrent.minimumBackgroundRefreshInterval,
      fetch: () =>
        this.request<ProwlarrApiSearchItem[]>(
          'search',
          {
            query,
            type,
            indexerIds,
            ...(limit !== undefined && { limit }),
            ...(offset !== undefined && { offset }),
          },
          ProwlarrApiSearchSchema
        ),
      isEmpty: (result) => result.data.length === 0,
    });
  }

  private getPath(endpoint: string) {
    return `${this.baseUrl}${this.baseApiPath}/${endpoint}`;
  }

  private async request<T>(
    endpoint: string,
    params: Record<
      string,
      string | number | boolean | (string | number)[]
    > = {},
    schema: z.ZodType<T>,
    timeout?: number
  ): Promise<ProwlarrApiResponse<T>> {
    sourceSearchContext.getStore()?.signal?.throwIfAborted();
    const { result } = await DistributedLock.getInstance().withLock(
      `${this.cacheScope}:${endpoint}:${JSON.stringify(params)}`,
      () =>
        endpoint === 'search'
          ? scheduleSourceSearch(
              this.baseUrl,
              appConfig.builtins.scrape.queryConcurrency,
              () => this._request(endpoint, params, schema, timeout)
            )
          : this._request(endpoint, params, schema, timeout),
      {
        timeout: (timeout ?? this.#timeout) + 25_000,
        ttl: ((timeout ?? this.#timeout) + 25_000) * 2,
      }
    );
    return result;
  }

  private async _request<T>(
    endpoint: string,
    params: Record<
      string,
      string | number | boolean | (string | number)[]
    > = {},
    schema: z.ZodType<T>,
    timeout?: number
  ): Promise<ProwlarrApiResponse<T>> {
    const url = new URL(this.getPath(endpoint));
    const headers = this.#headers;

    // Create URLSearchParams and handle array parameters
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) {
        // Handle array parameters by adding multiple entries with the same key
        value.forEach((item) => searchParams.append(key, String(item)));
      } else {
        // Handle non-array parameters
        searchParams.append(key, String(value));
      }
    }

    url.search = searchParams.toString();
    const response = await makeRequest(url.toString(), {
      method: 'GET',
      headers,
      timeout: timeout ?? this.#timeout,
      signal: sourceSearchContext.getStore()?.signal
        ? AbortSignal.any([
            sourceSearchContext.getStore()!.signal!,
            AbortSignal.timeout(timeout ?? this.#timeout),
          ])
        : undefined,
    });

    const meta: ResponseMeta = {
      headers: Object.fromEntries(response.headers.entries()),
      status: response.status,
      statusText: response.statusText,
    };

    if (!response.ok) {
      try {
        throw new ProwlarrApiError(
          ProwlarrErrorSchema.parse(await response.json()).message,
          response.status,
          response.statusText
        );
      } catch (error) {
        throw new ProwlarrApiError(
          `Generic HTTP error: ${response.status} - ${response.statusText}`,
          response.status,
          response.statusText
        );
      }
    }

    const { success, data, error } = schema.safeParse(await response.json());

    if (!success) {
      throw new ProwlarrApiError(
        `Prowlarr API error: ${formatZodError(error)}`,
        response.status,
        response.statusText
      );
    }

    return {
      data,
      meta,
    };
  }
}

export default ProwlarrApi;
