import { BaseDebridAddon, BaseDebridConfigSchema } from '../base/debrid.js';
import { z } from 'zod';
import { createLogger, getTimeTakenSincePoint } from '../../utils/index.js';
import { config as appConfig } from '../../config/index.js';
import ProwlarrApi, {
  ProwlarrApiIndexer,
  ProwlarrApiSearchItem,
  ProwlarrApiError,
  ProwlarrApiTagItem,
} from './api.js';
import { ParsedId } from '../../utils/id-parser.js';
import { SearchMetadata } from '../base/debrid.js';
import { Torrent, NZB, UnprocessedTorrent } from '../../debrid/index.js';
import {
  extractInfoHashFromMagnet,
  extractTrackersFromMagnet,
  validateInfoHash,
} from '../utils/debrid.js';
import { createQueryLimit, getTitleLanguagesForUrl } from '../utils/general.js';
import { hashNzbUrl } from '../../debrid/utils.js';
import { Stream } from '../../db/schemas.js';
import { recordSourceSearch } from '../../utils/source-search.js';
import {
  uniqueSearchQueries,
  seasonSearchQueries,
  selectSeasonResults,
} from './season-search.js';

export const ProwlarrAddonConfigSchema = BaseDebridConfigSchema.extend({
  url: z.string(),
  apiKey: z.string(),
  indexers: z.array(z.string()),
  tags: z.array(z.string()),
  sources: z.array(z.string()).optional(),
});

export type ProwlarrAddonConfig = z.infer<typeof ProwlarrAddonConfigSchema>;

const logger = createLogger('prowlarr');

export class ProwlarrAddon extends BaseDebridAddon<ProwlarrAddonConfig> {
  readonly id = 'prowlarr';
  readonly name = 'Prowlarr';
  readonly version = '1.0.0';
  readonly logger = logger;
  readonly api: ProwlarrApi;

  public static preconfiguredIndexers: ProwlarrApiIndexer[] | undefined;

  private readonly preconfiguredInstance: boolean;
  private readonly indexers: string[] = [];
  private readonly tags: string[] = [];
  private readonly sources: string[] = [];
  private readonly seasonProtocols = new Set<'torrent' | 'usenet'>();
  private readonly exactProtocols = new Set<'torrent' | 'usenet'>();
  private readonly unmatchedProtocols = new Set<'torrent' | 'usenet'>();

  protected onProcessedSources(
    protocol: 'torrent' | 'usenet',
    count: number
  ): void {
    if (
      count === 0 &&
      this.seasonProtocols.has(protocol) &&
      !this.exactProtocols.has(protocol)
    )
      this.unmatchedProtocols.add(protocol);
  }
  public async getStreams(type: string, id: string): Promise<Stream[]> {
    this.seasonProtocols.clear();
    this.exactProtocols.clear();
    this.unmatchedProtocols.clear();
    const first = await super.getStreams(type, id);
    if (this.unmatchedProtocols.size === 0) return first;
    // At most one exact fallback per protocol. A season pack is a candidate,
    // never proof of a validated playable episode or provider availability.
    for (const protocol of this.unmatchedProtocols)
      this.exactProtocols.add(protocol);
    const second = await super.getStreams(type, id);
    const seen = new Set<string>();
    return [...first, ...second].filter((s) => {
      const key = JSON.stringify([
        s.url,
        s.nzbUrl,
        s.infoHash,
        s.fileIdx,
        s.externalUrl,
        s.name,
        s.description,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  constructor(config: ProwlarrAddonConfig, clientIp?: string) {
    super(config, ProwlarrAddonConfigSchema, clientIp);

    this.preconfiguredInstance =
      appConfig.builtins.prowlarr.url === config.url &&
      appConfig.builtins.prowlarr.apiKey === config.apiKey;
    this.indexers = config.indexers.map((x) => x.toLowerCase());
    this.tags = config.tags.map((x) => x.toLowerCase());
    this.sources = (config.sources ?? []).map((x) => x.toLowerCase());
    this.api = new ProwlarrApi({
      baseUrl: config.url,
      apiKey: config.apiKey,
      timeout: appConfig.builtins.prowlarr.searchTimeout,
    });
  }

  public static async fetchpreconfiguredIndexers(): Promise<void> {
    if (this.preconfiguredIndexers) return;
    if (!appConfig.builtins.prowlarr.url || !appConfig.builtins.prowlarr.apiKey)
      return;
    const api = new ProwlarrApi({
      baseUrl: appConfig.builtins.prowlarr.url,
      apiKey: appConfig.builtins.prowlarr.apiKey,
      timeout: 5000,
    });
    const { data } = await api.indexers();
    logger.debug(`Fetched ${data.length} preconfigured indexers`);
    let filterReasons: Map<string, number> = new Map();

    this.preconfiguredIndexers = data.filter((indexer) => {
      if (!indexer.enable) {
        filterReasons.set(
          'not enabled',
          (filterReasons.get('not enabled') ?? 0) + 1
        );
        return false;
      }
      // if (indexer.protocol !== 'torrent') {
      //   filterReasons.set(
      //     'not torrent protocol',
      //     (filterReasons.get('not torrent protocol') ?? 0) + 1
      //   );
      //   return false;
      // }
      if (appConfig.builtins.prowlarr.indexers?.length) {
        if (
          ![
            indexer.name.toLowerCase(),
            indexer.sortName.toLowerCase(),
            indexer.definitionName.toLowerCase(),
          ].some((x) =>
            appConfig.builtins.prowlarr.indexers
              ?.map((x) => x.toLowerCase())
              .includes(x)
          )
        ) {
          filterReasons.set(
            'not in preconfigured indexers',
            (filterReasons.get('not in preconfigured indexers') ?? 0) + 1
          );
          return false;
        }
      }
      return true;
    });
    logger.debug(
      `Set ${this.preconfiguredIndexers?.length} preconfigured indexers`
    );
    if (filterReasons.size > 0) {
      logger.debug(
        `Filter reasons: ${Array.from(filterReasons.entries())
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ')}`
      );
    }
  }

  /**
   * Get indexers filtered by protocol (torrent or usenet)
   */
  private async getIndexersByProtocol(
    protocol: 'torrent' | 'usenet'
  ): Promise<ProwlarrApiIndexer[]> {
    let availableIndexers: ProwlarrApiIndexer[] = [];
    let chosenTags: number[] = [];

    if (this.preconfiguredInstance && ProwlarrAddon.preconfiguredIndexers) {
      availableIndexers = ProwlarrAddon.preconfiguredIndexers;
    } else {
      try {
        const { data } = await this.api.indexers();
        availableIndexers = data;
      } catch (error) {
        if (error instanceof ProwlarrApiError) {
          throw new Error(
            `Failed to get Prowlarr indexers: ${error.message}: ${error.status} - ${error.statusText}`
          );
        }
        throw new Error(`Failed to get Prowlarr indexers: ${error}`);
      }
    }

    try {
      const { data } = await this.api.tags();
      chosenTags = data
        .filter((tag) => this.tags.includes(tag.label.toLowerCase()))
        .map((tag) => tag.id);
    } catch (error) {
      logger.warn(`Failed to get Prowlarr tags: ${error}`);
    }

    const chosenIndexers = availableIndexers.filter(
      (indexer) =>
        indexer.enable &&
        indexer.protocol === protocol &&
        ((!this.indexers.length && !chosenTags.length) ||
          (chosenTags.length &&
            indexer.tags.some((tag) => chosenTags.includes(tag))) ||
          (this.indexers.length &&
            (this.indexers.includes(indexer.name.toLowerCase()) ||
              this.indexers.includes(indexer.definitionName.toLowerCase()) ||
              this.indexers.includes(indexer.sortName.toLowerCase()))))
    );

    this.logger.info(
      `Chosen ${protocol} indexers: ${chosenIndexers.map((indexer) => indexer.name).join(', ')}`
    );

    return chosenIndexers;
  }

  /**
   * Common search method that performs the actual Prowlarr API search
   * @param protocol - The protocol type ('torrent' or 'usenet')
   * @param parsedId - The parsed content ID
   * @param metadata - Search metadata
   * @returns Array of search results from Prowlarr
   */
  private async performSearch(
    protocol: 'torrent' | 'usenet',
    parsedId: ParsedId,
    metadata: SearchMetadata
  ): Promise<ProwlarrApiSearchItem[]> {
    if (this.sources.length > 0 && !this.sources.includes(protocol)) {
      return [];
    }

    const queryLimit = createQueryLimit();
    const chosenIndexers = await this.getIndexersByProtocol(protocol);

    if (chosenIndexers.length === 0) {
      this.logger.warn(`No ${protocol} indexers available`);
      return [];
    }

    const queries = uniqueSearchQueries(
      this.buildQueries(parsedId, metadata, {
        titleLanguages: getTitleLanguagesForUrl(this.userData.url, this.id),
      })
    );
    if (queries.length === 0) {
      return [];
    }

    const search = (batch: string[]) =>
      Promise.all(
        batch.map((q) =>
          queryLimit(async () => {
            const start = Date.now();
            const { data } = await this.api.search({
              query: q,
              indexerIds: chosenIndexers.map((indexer) => indexer.id),
              type: 'search',
              limit: 2000,
            });
            this.logger.info(
              `Prowlarr ${protocol} search for ${q} took ${getTimeTakenSincePoint(start)}`,
              {
                results: data.length,
              }
            );
            return data;
          })
        )
      ).then((results) => results.flat());
    const season = Number(parsedId.season),
      episode = Number(parsedId.episode);
    const broad =
      parsedId.mediaType === 'series' &&
      season > 0 &&
      episode > 0 &&
      !metadata.isDateBased
        ? seasonSearchQueries(queries, season)
        : [];
    if (broad.length === 0) return search(queries);
    const exact = queries.filter((q) => !broad.includes(q));
    if (this.exactProtocols.has(protocol)) {
      recordSourceSearch('episodeFallbacks');
      return search(exact);
    }
    const inventory = await search(broad);
    const matches = selectSeasonResults(inventory, season, episode);
    // A capped raw result page cannot establish complete season coverage.
    if (matches.length > 0 && inventory.length < 2000) {
      this.seasonProtocols.add(protocol);
      recordSourceSearch('seasonReused');
      return matches;
    }
    this.exactProtocols.add(protocol);
    recordSourceSearch('episodeFallbacks');
    return [...matches, ...(await search(exact))];
  }

  protected async _searchTorrents(
    parsedId: ParsedId
  ): Promise<UnprocessedTorrent[]> {
    const metadata = await this.getSearchMetadata();
    const results = await this.performSearch('torrent', parsedId, metadata);
    if (results.length === 0) return [];

    const seenTorrents = new Set<string>();
    const torrents: UnprocessedTorrent[] = [];

    for (const result of results) {
      const magnetUrl = result.guid?.includes('magnet:')
        ? result.guid
        : undefined;
      const downloadUrl = result.magnetUrl?.startsWith('http')
        ? result.magnetUrl
        : result.downloadUrl;
      const infoHash = validateInfoHash(
        result.infoHash ||
          (magnetUrl ? extractInfoHashFromMagnet(magnetUrl) : undefined)
      );
      if (!infoHash && !downloadUrl) continue;
      if (seenTorrents.has(infoHash ?? downloadUrl!)) continue;
      seenTorrents.add(infoHash ?? downloadUrl!);

      torrents.push({
        hash: infoHash,
        guid: result.guid,
        downloadUrl: downloadUrl,
        sources: magnetUrl ? extractTrackersFromMagnet(magnetUrl) : [],
        seeders: result.seeders,
        title: result.title,
        size: result.size,
        indexer: result.indexer,
        type: 'torrent',
      });
    }
    return torrents;
  }

  protected async _searchNzbs(parsedId: ParsedId): Promise<NZB[]> {
    const metadata = await this.getSearchMetadata();
    const results = await this.performSearch('usenet', parsedId, metadata);
    if (results.length === 0) return [];

    const seenNzbs = new Set<string>();
    const nzbs: NZB[] = [];

    for (const result of results) {
      const nzbUrl = result.downloadUrl ?? result.guid;
      if (!nzbUrl) continue;
      if (seenNzbs.has(nzbUrl)) continue;
      seenNzbs.add(nzbUrl);

      const hash = hashNzbUrl(nzbUrl);

      nzbs.push({
        hash,
        nzb: nzbUrl,
        age: Math.ceil(result.age * 24),
        title: result.title,
        size: result.size,
        indexer: result.indexer,
        type: 'usenet',
      });
    }
    return nzbs;
  }
}
