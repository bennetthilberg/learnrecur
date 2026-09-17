export const PRACTICE_BUFFER_SIZE = 10;
export const PRACTICE_BUFFER_LOW_WATER = 3;

export function appendPracticeBuffer<T>(current: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return [...current, ...incoming].filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, PRACTICE_BUFFER_SIZE);
}
