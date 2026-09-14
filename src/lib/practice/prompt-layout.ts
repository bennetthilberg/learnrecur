// Legacy prompts combine directions and exercise content in one string. Only
// split explicit instruction prefixes; never treat an arbitrary first line as a label.
export function splitPracticePrompt(prompt: string): { instruction: string | null; content: string } {
  const match = prompt.match(/^((?:Choose|Select|Complete|Fill|Type|Enter|Write|Identify|Match|Solve|Simplify|Calculate|Evaluate|Translate)\b[^\n\r:$\\]*?(?::|[.!?](?=\r?\n)))\s+([\s\S]+)$/i);
  if (!match || !match[2].trim()) return { instruction: null, content: prompt };
  return { instruction: match[1], content: match[2].trimStart() };
}
