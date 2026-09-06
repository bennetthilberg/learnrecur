import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";

// Small adversarial corpus shared by deterministic and generation-contract tests.
// Source statements bound the approved target; they are not additional prerequisites.
export const retentionTextFixtures = [
  {
    id: "spanish",
    title: "Spanish preterite form",
    tags: ["Spanish", "grammar"],
    source:
      "The third-person singular preterite of hablar is habló. Use familiar vocabulary.",
    prompt: "Complete the preterite form: Ayer ella ___ con Ana. (hablar)",
    answer: "habló",
    wrong: "hablo",
    equivalent: "hablo\u0301",
    policy: NATURAL_TEXT_POLICY,
  },
  {
    id: "french",
    title: "French terminology",
    tags: ["French", "terminology"],
    source:
      "The French noun for coast is côte. The accent distinguishes it from cote.",
    prompt: "Write the French noun meaning coast.",
    answer: "côte",
    wrong: "cote",
    equivalent: "co\u0302te",
    policy: NATURAL_TEXT_POLICY,
  },
  {
    id: "technical",
    title: "Case-sensitive command syntax",
    tags: ["programming"],
    source:
      "This toy protocol accepts the literal command GET /v1 with one space and uppercase GET.",
    prompt: "Write the literal command for version 1 of the toy protocol.",
    answer: "GET /v1",
    wrong: "get  /v1",
    equivalent: "GET /v1",
    policy: EXACT_TEXT_POLICY,
  },
] as const;
export function retentionGeneratedText(
  fixture: (typeof retentionTextFixtures)[number],
) {
  return {
    prompt: fixture.prompt,
    answerKind: "TEXT" as const,
    answerSpec: textAnswerContract([fixture.answer], fixture.policy),
    correctAnswerDisplay: fixture.answer,
    explanation: fixture.source,
    difficulty: 3,
    expectedSeconds: 30,
  };
}
export const retentionMathFixtures = [
  {
    answerKind: "NUMERIC" as const,
    choices: null,
    answerSpec: { kind: "numeric", accepted: ["1/2"], tolerance: 0 },
    answer: "0.5",
    wrong: "2",
  },
  {
    answerKind: "MATH" as const,
    choices: null,
    answerSpec: {
      kind: "math",
      acceptedExpressions: ["3*x"],
      equivalence: "basic-symbolic",
    },
    answer: "x+x+x",
    wrong: "x+3",
  },
];
export const retentionBiologyFixture = {
  source:
    "Osmosis is the movement of water across a selectively permeable membrane. Diffusion describes net particle movement down a concentration gradient.",
  prompt:
    "Water crosses a selectively permeable membrane toward the more concentrated solution. Which process describes this?",
  choices: [
    { id: "osmosis", label: "Osmosis" },
    { id: "diffusion", label: "Solute diffusion" },
    { id: "transport", label: "Active solute transport" },
  ],
  correctChoiceId: "osmosis",
  explanation:
    "The stated movement is water crossing a selectively permeable membrane, the defining condition for osmosis.",
  difficulty: 3,
  expectedSeconds: 30,
};
