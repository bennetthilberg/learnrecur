import { readStructuredPrompt } from "@/lib/practice/structured-prompt";
import { splitPracticePrompt } from "@/lib/practice/prompt-layout";
import { MathText } from "./math-text";

export function PracticePrompt({ text, layout }: { text: string; layout?: unknown }) {
  const { instruction, content } = readStructuredPrompt(text, layout) ?? splitPracticePrompt(text);
  return (
    <article className="practicePromptPanel" aria-live="polite" aria-atomic="true">
      {instruction ? <p className="practiceInstruction"><MathText text={instruction} /></p> : null}
      <p><MathText formatBlanks text={content} /></p>
    </article>
  );
}
