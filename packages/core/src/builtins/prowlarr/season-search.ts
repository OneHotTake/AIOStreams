import FileParser from '../../parser/file.js';

export function uniqueSearchQueries(queries: string[]): string[] {
  return [
    ...new Set(
      queries
        .map((q) => q.trim().replace(/\s+/g, ' ').toLowerCase())
        .filter(Boolean)
    ),
  ];
}
export function seasonSearchQueries(
  queries: string[],
  season: number
): string[] {
  return queries.filter((q) => {
    const match = q.match(/\sS(\d{1,3})$/i);
    return match && Number(match[1]) === season;
  });
}
export function selectSeasonResults<T extends { title: string }>(
  results: T[],
  season: number,
  episode: number
): T[] {
  return results.filter((result) => {
    const parsed = FileParser.parse(result.title);
    return (
      parsed.seasons?.includes(season) &&
      (parsed.seasonPack || parsed.episodes?.includes(episode))
    );
  });
}
