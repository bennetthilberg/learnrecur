// Catch explicit choice lists at the contract boundary. The semantic verifier
// also checks less regular answer cues; this deliberately avoids guessing from
// ordinary question context or merely mentioning the subject's rules.
export function hasExplicitAnswerOptions(prompt: string): boolean {
  const text = prompt.normalize("NFKC");
  const labelledOptions = text.match(/(?:^|\s)[a-e][).]\s+\S/gi) ?? [];
  const numberedOptions = text.match(/(?:^|\n)\s*\d+[).]\s+\S/g) ?? [];
  return labelledOptions.length >= 2 ||
    (numberedOptions.length >= 2 && /\b(?:(?:choose|select|pick)\b[^\n.!?]{0,80}|options|choices)[:?]\s*\d+[).]/i.test(text)) ||
    /\b(?:choose|select|pick)\s+from\s*:/i.test(text) ||
    /\bwhich\b[^\n:?!]{1,160}:[^\n:?!]{1,100},[^\n:?!]{1,100},?\s+or\s+[^\n:?!]{1,80}\?/i.test(text);
}
