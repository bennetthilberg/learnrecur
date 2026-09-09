import { describe, expect, it } from "vitest";

import { Prisma } from "@/generated/prisma/client";
import { agentSetupPreviewSchema } from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  isSerializationConflict,
  normalizeSetupOperationStatus,
  publicSetupError,
  projectSetupPlannedChanges,
  requiredSetupScopes,
  stableHash,
  validateSetupReferences,
} from "@/lib/agent-access/setup";

describe("agent setup progress contracts", () => {
  it("keeps documented operation errors public and hides unexpected details", () => {
    const privateMarker = "provider-prisma-private-marker";

    expect(publicSetupError(new AgentOperationError("invalid_input", "Use a supported setup value."))).toEqual({
      code: "invalid_input",
      message: "Use a supported setup value.",
    });
    expect(publicSetupError(new Error(privateMarker))).toEqual({
      code: "internal_error",
      message: "The setup action could not be completed.",
    });
    expect(JSON.stringify(publicSetupError(new Error(privateMarker)))).not.toContain(privateMarker);
  });

  it.each([
    ["P2034", undefined, true],
    ["P2010", { code: "40001" }, true],
    ["P2010", { code: "40P01" }, true],
    [
      "P2010",
      {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "40001",
            originalMessage: "could not serialize access due to concurrent update",
            kind: "TransactionWriteConflict",
          },
        },
      },
      true,
    ],
    [
      "P2010",
      {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "40P01", kind: "Other" },
        },
      },
      true,
    ],
    [
      "P2010",
      {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { code: "40001", kind: "Other" },
        },
      },
      true,
    ],
    ["P2010", { code: "23505" }, false],
    ["P2002", { code: "40001" }, false],
    [
      "P2010",
      {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { originalCode: "23505", kind: "UniqueViolation" },
        },
      },
      false,
    ],
  ] as const)("classifies claim serialization conflicts (%s, %j)", (code, meta, expected) => {
    const error = new Prisma.PrismaClientKnownRequestError("database error", {
      code,
      clientVersion: "test",
      meta,
    });
    expect(isSerializationConflict(error)).toBe(expected);
  });

  it("hashes snapshots canonically across JSON object key order", () => {
    expect(stableHash({ user: { desired_retention: 0.9, practice_timezone: "UTC" }, reminder: null })).toBe(
      stableHash({ reminder: null, user: { practice_timezone: "UTC", desired_retention: 0.9 } }),
    );
  });

  it("projects reviewable changes without sources or candidate answers", () => {
    const input = agentSetupPreviewSchema.parse({
      idempotency_key: "projection-plan-001",
      collections: [
        { kind: "reuse", collection_id: "existing-collection" },
        { kind: "create", client_reference: "topic", name: "Topic", description: null },
      ],
      skills: [
        {
          kind: "reuse",
          skill_id: "existing-skill",
          collection_id: null,
          tags: [],
        },
        {
          kind: "create_specs",
          client_reference: "spec-skill",
          skill: {
            title: "A generated skill",
            objective: "Explain this topic clearly to the learner.",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: ["generated"],
            collection: "Topic",
          },
          candidate_exercises: [
            {
              kind: "text",
              prompt: "What is the answer?",
              acceptedAnswers: ["secret answer"],
            },
          ],
        },
        {
          kind: "create_text",
          client_reference: "text-skill",
          source_text: "private text",
          intent: "Summarize this source clearly.",
          source_label: "Private notes",
          collection_reference: "topic",
          tags: [],
        },
        {
          kind: "create_material",
          client_reference: "material-skill",
          material_id: "material-1",
          expected_revision_id: "revision-1",
          instruction: "Extract the durable concepts.",
          section_ids: ["section-1"],
          collection_reference: "topic",
          max_skills: 2,
        },
      ],
      practice: {
        practice_preference: "BALANCED",
        mixed_review: false,
        daily_new_skill_limit: 0,
        practice_timezone: "UTC",
        desired_retention: null,
        practice_day_start_minutes: 0,
      },
      reminders: {
        enabled: false,
        email: "",
        local_hour: 0,
        timezone: "UTC",
        minimum_due_count: 1,
      },
    });

    const projected = projectSetupPlannedChanges(input);
    expect(projected.practice).toEqual({
      practice_preference: "BALANCED",
      mixed_review: false,
      daily_new_skill_limit: 0,
      practice_timezone: "UTC",
      desired_retention: null,
      practice_day_start_minutes: 0,
    });
    expect(projected.reminders).toEqual({
      enabled: false,
      email: "",
      local_hour: 0,
      timezone: "UTC",
      minimum_due_count: 1,
    });
    expect(projected.collections).toEqual([
      { action: "reuse", collection_id: "existing-collection" },
      { action: "create", client_reference: "topic", name: "Topic", description: null },
    ]);
    expect(projected.skills).toEqual([
      {
        action: "reuse",
        skill_id: "existing-skill",
        move: { collection_id: null },
        tags: [],
      },
      {
        action: "create_specs",
        client_reference: "spec-skill",
        title: "A generated skill",
        objective: "Explain this topic clearly to the learner.",
        placement: { collection: "Topic" },
      },
      {
        action: "create_text",
        client_reference: "text-skill",
        intent: "Summarize this source clearly.",
        source_label: "Private notes",
        source_char_count: 12,
        placement: { collection_reference: "topic" },
      },
      {
        action: "create_material",
        client_reference: "material-skill",
        material_id: "material-1",
        expected_revision_id: "revision-1",
        section_ids: ["section-1"],
        max_skills: 2,
        placement: { collection_reference: "topic" },
      },
    ]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private text");
    expect(serialized).not.toContain("secret answer");
    expect(serialized).not.toContain("acceptedAnswers");
    expect(serialized).not.toContain("candidate_exercises");
  });

  it.each([
    ["SUCCEEDED", { public: "succeeded", terminal: true, successful: true, failed: false }],
    ["succeeded", { public: "succeeded", terminal: true, successful: true, failed: false }],
    ["FAILED", { public: "failed", terminal: true, successful: false, failed: true }],
    ["partial", { public: "partial", terminal: true, successful: false, failed: true }],
    ["GENERATING", { public: "generating", terminal: false, successful: false, failed: false }],
  ] as const)("normalizes child operation status %s", (raw, expected) => {
    expect(normalizeSetupOperationStatus(raw)).toMatchObject(expected);
  });

  it("preflights every scope needed by a mixed setup plan", () => {
    const input = agentSetupPreviewSchema.parse({
      idempotency_key: "mixed-plan-001",
      collections: [
        { kind: "create", client_reference: "topic", name: "Topic" },
        { kind: "reuse", collection_id: "collection-1" },
      ],
      skills: [
        { kind: "reuse", skill_id: "skill-1", tags: ["review"] },
        {
          kind: "create_material",
          client_reference: "material-skill",
          material_id: "material-1",
          expected_revision_id: "revision-1",
          instruction: "Extract the core concepts.",
          collection_reference: "topic",
          max_skills: 2,
        },
      ],
      practice: { desired_retention: 0.9 },
      reminders: { enabled: true },
    });

    expect(requiredSetupScopes(input)).toEqual(
      expect.arrayContaining([
        "setup:write",
        "collections:write",
        "collections:read",
        "skills:write",
        "skills:create",
        "materials:read",
        "practice:write",
        "reminders:write",
      ]),
    );
  });

  it("rejects setup actions whose deterministic journal keys would collide", () => {
    const skillCollision = agentSetupPreviewSchema.parse({
      idempotency_key: "collision-plan-skills",
      skills: [
        { kind: "reuse", skill_id: "same-step" },
        {
          kind: "create_specs",
          client_reference: "same-step",
          skill: {
            title: "A duplicate step",
            objective: "Describe a duplicate setup step safely.",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: [],
          },
        },
      ],
    });
    const collectionCollision = agentSetupPreviewSchema.parse({
      idempotency_key: "collision-plan-collections",
      collections: [
        { kind: "reuse", collection_id: "topic" },
        { kind: "create", client_reference: "topic", name: "Topic" },
      ],
    });

    expect(() => validateSetupReferences(skillCollision)).toThrow(/distinct steps/);
    expect(() => validateSetupReferences(collectionCollision)).toThrow(/distinct steps/);
  });
});
