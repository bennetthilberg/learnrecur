import { splitPracticePrompt } from "@/lib/practice/prompt-layout";
import { MathText } from "./math-text";

export function PracticePrompt({ text }: { text: string }) {
  const { instruction, content } = splitPracticePrompt(text);
  return (
    <article className="practicePromptPanel">
      {instruction ? <p className="practiceInstruction"><MathText text={instruction} /></p> : null}
      <p><MathText formatBlanks text={content} /></p>
    </article>
  );
}
