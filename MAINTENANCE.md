# Season reuse and maintenance scheduling

This branch is based on upstream v2.34.1. It keeps both torrent and Usenet paths,
profile filters, provider validation and playback behavior. It does not change
Prowlarr indexer policy or increase configured query concurrency.

For ordinary aired season/episode IDs, Prowlarr searches season queries first.
The raw inventory is shared by normalized title query, sorted selected indexers,
protocol-specific selection, endpoint/credential digest and page parameters.
Concurrent identical lookups share one fetch; later siblings match episodes locally
from the persistent cache. This means one request per distinct season query/cache
window, not one universal request across all title variants and both protocols.
The existing positive cache TTL/background-refresh interval remains configurable.
Date and absolute numbering retain their original search path. Unknown season
mappings are never guessed.

A missing episode, a capped result page or zero validated provider files triggers
one exact fallback per protocol. Season packs are candidates, not proof that the
requested file exists. Existing final AIO profile filters still run after addon
output; that stage can remove candidates independently of source validation.

Empty raw results persist for two minutes. Failed requests are never cached as
empty successes. Failed refreshes wait 15s,60s,5m,15m; empty/failed background
refreshes preserve good inventory and advance their refresh cooldown. The SQL
cache uses new versioned namespaces and isolates credentials with SHA256 digests;
raw responses remain private in the existing AIO DB. Back up current DB/config
before deployment. No migration/reset or API credential change is required.

A process-wide scheduler per Prowlarr endpoint applies the existing queryConcurrency
to actual search HTTP calls, across lookups and protocols. Queue capacity256,
wait deadline25s. Playback-priority work can claim eight slots before a queued
maintenance request gets its turn. Cancelled queued work never starts; active
fetches receive their own request’s cancellation signal. Multiple replicas each
have a local scheduler; this is not a distributed global concurrency guarantee.
Marvin marks its lane with X-AIOStreams-Maintenance:1. Unmarked clients receive
normal priority. Positive-cache reads do not consume search slots.

The existing administrator-only API adds GET /api/v1/dashboard/source-searches:
submitted/completed source calls, active/queued work, cache/negative hits,
coalescing, requested background refreshes, queue/source milliseconds, season reuse
and exact fallbacks. Counters reset on process restart. Submitted Prowlarr calls
are not per-indexer HTTP fanout. No query, private endpoint or credential is returned.

Build with Dockerfile.maintenance against the pinned deployed runtime. Pass
SOURCE_REVISION and SOURCE_TIME to identify the reviewed source commit. The build
compiles core/server, runs core tests, and replaces only those packages plus version
metadata; frontend and production dependencies stay on upstream v2.34.1. This is a
maintained fork, not an official upstream release. Roll back the image while keeping
current databases and user state. Source remains available under upstream AGPL3.
