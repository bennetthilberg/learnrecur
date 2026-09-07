// Catch explicit choice lists at the contract boundary. The semantic verifier
// also checks less regular answer cues; this deliberately avoids guessing from
// ordinary question context or merely mentioning the subject's rules.
export function hasExplicitAnswerOptions(prompt: string): boolean {
  const text = prompt.normalize("NFKC");
  const labelledOptions = text.match(/(?:^|\n)\s*[a-e][).]\s+\S/gi) ?? [];
  return labelledOptions.length >= 2 ||
    /\b(?:choose|select|pick)\s+from\s*:/i.test(text) ||
    /:[^\n:?!]{1,100},[^\n:?!]{1,100},?\s+or\s+[^\n:?!]{1,80}[?.]/i.test(text);
}
