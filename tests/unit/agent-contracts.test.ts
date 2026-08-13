import { describe, expect, it } from "vitest";

import {
  agentAddFromMaterialSchema,
  agentAddFromSpecsSchema,
  agentAddFromTextSchema,
  agentCandidateExerciseSchema,
  agentGetOperationSchema,
  agentPrepareFilesSchema,
  agentSearchMaterialExcerptsSchema,
  buildAgentCandidateDuplicateKey,
  buildAgentPayloadHash,
  normalizeAgentCandidateExercise,
} from "@/lib/agent-access/contracts";

const skill = {
  title: "Choose ser or estar",
  objective: "Choose the correct verb for identity, location, and temporary state.",
  rules: ["Use ser for identity."],
  examples: ["Ella es médica."],
  exerciseConstraints: "Use short Spanish sentences.",
  tags: ["spanish", "grammar"],
  collection: "Spanish",
};

describe("agent MCP contracts", () => {
  it("accepts a bounded structured batch and rejects caller-owned fields", () => {
    expect(
      agentAddFromSpecsSchema.parse({
        idempotency_key: "spec-batch-001",
        items: [{ client_reference: "ser-estar", skill }],
      }).items,
    ).toHaveLength(1);

    expect(() =>
      agentAddFromSpecsSchema.parse({
        idempotency_key: "spec-batch-001",
        userId: "attacker",
        items: [{ client_reference: "ser-estar", skill }],
      }),
    ).toThrow();
    expect(() =>
      agentAddFromSpecsSchema.parse({
        idempotency_key: "spec-batch-001",
        items: Array.from({ length: 11 }, (_, index) => ({
          client_reference: `skill-${index}`,
          skill,
        })),
      }),
    ).toThrow();
  });

  it("requires unique client references and caps candidates", () => {
    const candidate = {
      kind: "choice",
      prompt: "Which verb completes: Ella ___ médica?",
      choices: [
        { id: "a", label: "es" },
        { id: "b", label: "está" },
        { id: "c", label: "son" },
      ],
      correctChoiceId: "a",
    };

    expect(() =>
      agentAddFromSpecsSchema.parse({
        idempotency_key: "spec-batch-001",
        items: [
          { client_reference: "same", skill },
          { client_reference: "same", skill },
        ],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      agentAddFromSpecsSchema.parse({
        idempotency_key: "spec-batch-001",
        items: [
          {
            client_reference: "ser-estar",
            skill,
            candidate_exercises: Array.from({ length: 6 }, () => candidate),
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    {
      input: {
        kind: "choice",
        prompt: "Which verb completes: Ella ___ médica?",
        choices: [
          { id: "a", label: "es" },
          { id: "b", label: "está" },
          { id: "c", label: "son" },
        ],
        correctChoiceId: "a",
      },
      expected: { answerKind: "CHOICE", correctAnswerDisplay: "es" },
    },
    {
      input: {
        kind: "text",
        prompt: "Complete: Yo ___ de Chicago.",
        acceptedAnswers: ["soy"],
      },
      expected: { answerKind: "TEXT", correctAnswerDisplay: "soy" },
    },
    {
      input: {
        kind: "numeric",
        prompt: "What is three quarters as a decimal?",
        acceptedAnswers: ["3/4", "0.75"],
        displayAnswer: "0.75",
      },
      expected: { answerKind: "NUMERIC", correctAnswerDisplay: "0.75" },
    },
    {
      input: {
        kind: "math",
        prompt: "Differentiate 3x^4.",
        acceptedExpressions: ["12x^3", "12*x^3"],
      },
      expected: { answerKind: "MATH", correctAnswerDisplay: "12x^3" },
    },
  ])("normalizes and self-checks $input.kind candidates", ({ input, expected }) => {
    const parsed = agentCandidateExerciseSchema.parse(input);
    const normalized = normalizeAgentCandidateExercise(parsed, 0);

    expect(normalized).toMatchObject(expected);
    expect(normalized.candidateId).toBe("candidate-1");
  });

  it("rejects candidate answer keys that do not self-check", () => {
    expect(() =>
      normalizeAgentCandidateExercise(
        agentCandidateExerciseSchema.parse({
          kind: "numeric",
          prompt: "What is one half?",
          acceptedAnswers: ["1/2"],
          displayAnswer: "2",
        }),
        0,
      ),
    ).toThrow(/display answer/i);
    expect(() =>
      agentCandidateExerciseSchema.parse({
        kind: "choice",
        prompt: "Pick one answer.",
        choices: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
          { id: "c", label: "C" },
        ],
        correctChoiceId: "a",
      }),
    ).toThrow(/unique/i);
  });

  it("keeps source, material, file, excerpt, and operation contracts narrow", () => {
    expect(
      agentAddFromTextSchema.parse({
        idempotency_key: "text-source-001",
        source_text: "A compact explanation of when Spanish uses ser and estar.",
        intent: "Practice choosing the correct verb from the sentence context.",
      }).source_text,
    ).toContain("ser");
    expect(() =>
      agentAddFromTextSchema.parse({
        idempotency_key: "text-source-001",
        source_text: "A compact explanation of when Spanish uses ser and estar.",
        intent: "Practice choosing the correct verb from the sentence context.",
        source_url: "https://attacker.example/steal",
      }),
    ).toThrow();

    expect(
      agentAddFromMaterialSchema.parse({
        idempotency_key: "material-001",
        material_id: "material-1",
        expected_revision_id: "revision-2",
        instruction: "Create the most important narrow skills.",
        max_skills: 4,
      }).max_skills,
    ).toBe(4);
    expect(
      agentPrepareFilesSchema.parse({
        idempotency_key: "files-001",
        intent: "Practice the rules shown in these class worksheets.",
        files: [
          { name: "worksheet.pdf", media_type: "application/pdf", size_bytes: 1024 },
        ],
      }).files,
    ).toHaveLength(1);
    expect(
      agentSearchMaterialExcerptsSchema.parse({
        material_id: "material-1",
        expected_revision_id: "revision-2",
        query: "direct object pronouns",
        limit: 5,
      }).limit,
    ).toBe(5);
    expect(agentGetOperationSchema.parse({ operation_id: "operation-1" })).toEqual({
      operation_id: "operation-1",
    });
  });

  it("hashes canonical JSON independently of object key order", () => {
    expect(buildAgentPayloadHash({ b: 2, a: { d: 4, c: 3 } })).toBe(
      buildAgentPayloadHash({ a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(buildAgentPayloadHash({ value: 1 })).not.toBe(
      buildAgentPayloadHash({ value: 2 }),
    );
  });

  it("deduplicates candidates by practice identity rather than optional metadata", () => {
    const normalized = normalizeAgentCandidateExercise(
      agentCandidateExerciseSchema.parse({
        kind: "text",
        prompt: "Complete: Yo ___ de Chicago.",
        acceptedAnswers: ["soy"],
        explanation: "Identity uses ser.",
        difficulty: 2,
      }),
      0,
    );
    expect(
      buildAgentCandidateDuplicateKey(normalized),
    ).toBe(
      buildAgentCandidateDuplicateKey({
        ...normalized,
        prompt: "  COMPLETE: YO ___ DE CHICAGO. ",
        explanation: "Different optional wording.",
        difficulty: 5,
      }),
    );
  });
});
