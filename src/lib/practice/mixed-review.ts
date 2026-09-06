export type MixedReviewSkill = {
  id: string;
  collectionId: string | null;
  tags: readonly string[];
  objective: string | null;
  dueAt: Date;
};
const ignoredTerms = new Set([
  "practice",
  "choose",
  "identify",
  "apply",
  "correct",
  "using",
  "which",
  "with",
  "from",
  "this",
  "that",
  "given",
  "answer",
  "learn",
  "skill",
]);
function terms(value: string) {
  return new Set(
    value
      .toLowerCase()
      .normalize("NFC")
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter((term) => !ignoredTerms.has(term)) ?? [],
  );
}
export function areMixedReviewSkillsCompatible(
  a: MixedReviewSkill,
  b: MixedReviewSkill,
) {
  if (a.id === b.id || !a.collectionId || a.collectionId !== b.collectionId)
    return false;
  const tags = new Set(a.tags.map((tag) => tag.toLowerCase()));
  if (b.tags.some((tag) => tags.has(tag.toLowerCase()))) return true;
  const aTerms = terms(a.objective ?? "");
  return (
    [...terms(b.objective ?? "")].filter((term) => aTerms.has(term)).length >= 2
  );
}

// Preserve overdue-day priority. Within the earliest UTC due day only, vary
// compatible skills after the previous item. All candidates are already due;
// every completed item still updates exactly one FSRS card.
export function selectMixedReviewSkill<T extends MixedReviewSkill>(
  ordered: readonly T[],
  previous: MixedReviewSkill | null,
): T | null {
  const first = ordered[0];
  if (!first || !previous) return first ?? null;
  return (
    ordered.find(
      (skill) =>
        skill.dueAt.toISOString().slice(0, 10) ===
          first.dueAt.toISOString().slice(0, 10) &&
        areMixedReviewSkillsCompatible(previous, skill),
    ) ?? first
  );
}
