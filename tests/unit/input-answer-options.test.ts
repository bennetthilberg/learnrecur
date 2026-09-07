import { expect, it } from "vitest";
import { hasExplicitAnswerOptions } from "@/lib/skills/input-answer-options";
import { validateGeneratedExactInputExercises } from "@/lib/skills";
import { agentCandidateExerciseSchema } from "@/lib/agent-access/contracts";

it.each([
  "Which decimal equals 3/4?\nA) 0.25\nB) 0.75\nEnter the letter.",
  "Which French noun means school: vélo, école, or arbre?",
  'Which French noun means bicycle: "arbre", "école", or "vélo"? Write only the noun.',
  "Name the object. Choose from: livre, table, chaise.",
  "Select an answer:\n1. red\n2. blue\n3. green",
  "Which is correct? A) red B) blue C) green",
])("rejects an explicit answer list in a production prompt: %s", (prompt) => {
  expect(hasExplicitAnswerOptions(prompt)).toBe(true);
  expect(validateGeneratedExactInputExercises({ exercises: [{
    prompt, answerKind: "TEXT", answerSpec: { kind: "text", accepted: ["école"] },
    correctAnswerDisplay: "école",
  }] }).status).toBe("invalid");
  expect(agentCandidateExerciseSchema.safeParse({ kind: "text", prompt, acceptedAnswers: ["école"] }).success).toBe(false);
});

it.each([
  "Complete: Ayer ella ___ con Ana. (hablar, preterite)",
  "Write the French noun for a school. Omit the article.",
  "Convert 3/4 to a decimal.",
  "Given 3 apples, 2 pears, and 1 orange, how many fruits are there?",
  "Translate: I buy apples, pears, or oranges.",
  "Translate: Do you buy apples, pears, or oranges?",
  "Follow these steps:\n1. Differentiate x^2.\n2. Evaluate at x = 3.",
  "Write the exact command to read a record in the fictional protocol.",
])("keeps necessary question context: %s", (prompt) => {
  expect(hasExplicitAnswerOptions(prompt)).toBe(false);
});
