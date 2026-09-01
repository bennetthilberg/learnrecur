export const SOURCE_CONTEXT_CHAR_LIMIT = 4_000;
export const SOURCE_CONTEXT_TRUNCATION_MARKER = "\n\n[truncated]";

export function buildSourceContextExcerpt(
  sourceTexts: Array<string | null | undefined>,
): string | null {
  const joined = sourceTexts
    .map((sourceText) => (sourceText ?? "").trim())
    .filter(Boolean)
    .join("\n\n---\n\n");

  if (!joined) return null;
  const characters = Array.from(joined);
  if (characters.length <= SOURCE_CONTEXT_CHAR_LIMIT) return joined;

  const markerLength = Array.from(SOURCE_CONTEXT_TRUNCATION_MARKER).length;
  return `${characters
    .slice(0, SOURCE_CONTEXT_CHAR_LIMIT - markerLength)
    .join("")
    .trimEnd()}${SOURCE_CONTEXT_TRUNCATION_MARKER}`;
}
