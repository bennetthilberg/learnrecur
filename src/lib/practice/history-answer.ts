/** Resolve choice IDs to the labels the learner actually saw. Never stringify arbitrary JSON. */
export function formatSubmittedHistoryAnswer(answer: unknown, choices: unknown): string {
  if (answer && typeof answer === "object" && "raw" in answer) answer = answer.raw;
  if (typeof answer !== "string" && typeof answer !== "number") return "Answer unavailable";
  const text = String(answer);
  if (Array.isArray(choices)) {
    const choice = choices.find((value) => value && typeof value === "object" && value.id === text);
    if (choice && typeof choice.label === "string") return choice.label;
  }
  return text || "No answer";
}
