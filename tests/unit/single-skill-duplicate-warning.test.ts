import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  SkillSimilarityBulkResult,
  SkillSimilarityMatch,
} from "@/lib/skills/similarity";

const mocks = vi.hoisted(() => ({
  activateSkillDraft: vi.fn(),
  authProtect: vi.fn(),
  buildSkillDuplicateCandidateFingerprint: vi.fn(),
  currentUser: vi.fn(),
  ensureDatabaseUser: vi.fn(),
  findSimilarSkillsForUser: vi.fn(),
  findSkillDraftForReview: vi.fn(),
  revalidatePath: vi.fn(),
  updateSkillDraft: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: {
    protect: mocks.authProtect,
  },
  currentUser: mocks.currentUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

vi.mock("@/lib/users", () => ({
  ensureDatabaseUser: mocks.ensureDatabaseUser,
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    skill: {
      findFirst: mocks.findSkillDraftForReview,
    },
  }),
}));

vi.mock("@/lib/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/skills")>()),
  activateSkillDraft: mocks.activateSkillDraft,
  createSkillDraft: vi.fn(),
  createSkillDraftFromSource: vi.fn(),
  updateSkillDraft: mocks.updateSkillDraft,
  updateSkillPracticeGuidance: vi.fn(),
}));

vi.mock("@/lib/skills/similarity", () => ({
  buildSkillDuplicateCandidateFingerprint:
    mocks.buildSkillDuplicateCandidateFingerprint,
  findSimilarSkillsForUser: mocks.findSimilarSkillsForUser,
}));

const existingMatch: SkillSimilarityMatch = {
  skill: {
    id: "skill-existing",
    title: "Ser and estar in context",
    objective: "Choose ser or estar for identity, location, and temporary state.",
    status: "PAUSED",
    collectionName: "Spanish grammar",
    tags: ["spanish", "verbs"],
    contentFingerprint: "existing-content-fingerprint",
  },
  confidence: "likely",
  score: 0.92,
  lexicalScore: 0.84,
  semanticScore: 0.96,
  reasons: [],
};

function similarityResult(
  match: SkillSimilarityMatch | null,
): SkillSimilarityBulkResult {
  return {
    candidates: [
      {
        key: "skill-draft",
        bestMatch: match,
        matches: match ? [match] : [],
      },
    ],
    semanticStatus: "used",
  };
}

function draftFormData(duplicateOverrideSkillId?: string) {
  const formData = new FormData();
  formData.set("skillId", "skill-draft");
  formData.set("title", "Ser vs. estar");
  formData.set(
    "objective",
    "Choose between ser and estar for identity, location, and temporary state.",
  );
  formData.set("collectionName", "Spanish grammar");
  formData.set("rules", "Use ser for identity.\nUse estar for location.");
  formData.set("examples", "Soy estudiante.\nEstoy en casa.");
  formData.set("exerciseConstraints", "Use short classroom sentences.");
  formData.set("tags", "spanish, verbs");

  if (duplicateOverrideSkillId) {
    formData.set("duplicateOverrideSkillId", duplicateOverrideSkillId);
  }

  return formData;
}

describe("single-skill duplicate activation gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authProtect.mockResolvedValue({ userId: "user-alpha" });
    mocks.currentUser.mockResolvedValue({
      id: "user-alpha",
      primaryEmailAddress: {
        emailAddress: "learner@example.com",
      },
    });
    mocks.ensureDatabaseUser.mockResolvedValue({
      status: "ready",
      userId: "user-alpha",
    });
    mocks.buildSkillDuplicateCandidateFingerprint.mockReturnValue(
      "reviewed-draft-fingerprint",
    );
    mocks.updateSkillDraft.mockResolvedValue({
      status: "updated",
      skill: {
        id: "skill-draft",
        title: "Ser vs. estar",
        objective:
          "Choose between ser and estar for identity, location, and temporary state.",
        collectionId: "collection-spanish",
        rules: {
          items: ["Use ser for identity.", "Use estar for location."],
        },
        examples: {
          items: ["Soy estudiante.", "Estoy en casa."],
        },
        exerciseConstraints: {
          notes: "Use short classroom sentences.",
        },
        tags: ["spanish", "verbs"],
      },
    });
    mocks.activateSkillDraft.mockResolvedValue({
      status: "activated",
      skillId: "skill-draft",
    });
  });

  it("returns a persistent warning without starting activation generation", async () => {
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(existingMatch));
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "idle", message: null },
      draftFormData(),
    );

    expect(result).toMatchObject({
      status: "duplicate-warning",
      duplicateMatch: existingMatch,
      draftValues: {
        title: "Ser vs. estar",
        objective:
          "Choose between ser and estar for identity, location, and temporary state.",
        collectionName: "Spanish grammar",
        tags: "spanish, verbs",
      },
    });
    expect(mocks.findSimilarSkillsForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-alpha",
        candidates: [
          expect.objectContaining({
            key: "skill-draft",
            skillId: "skill-draft",
            title: "Ser vs. estar",
          }),
        ],
      }),
    );
    expect(mocks.activateSkillDraft).not.toHaveBeenCalled();
  });

  it("rechecks the match before honoring an explicit create-anyway override", async () => {
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(existingMatch));
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      {
        status: "duplicate-warning",
        message: null,
        duplicateMatch: existingMatch,
      },
      draftFormData(existingMatch.skill.id),
    );

    expect(mocks.findSimilarSkillsForUser).toHaveBeenCalledTimes(1);
    expect(mocks.activateSkillDraft).toHaveBeenCalledWith({
      userId: "user-alpha",
      skillId: "skill-draft",
      expectedDraftFingerprint: "reviewed-draft-fingerprint",
      expectedDuplicateMatch: {
        skillId: existingMatch.skill.id,
        fingerprint: existingMatch.skill.contentFingerprint,
      },
      now: expect.any(Date),
    });
    expect(result).toMatchObject({
      status: "activated",
      activatedSkillId: "skill-draft",
    });
  });

  it("does not honor an override that was not submitted from the warning shown", async () => {
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(existingMatch));
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "idle", message: null },
      draftFormData(existingMatch.skill.id),
    );

    expect(result).toMatchObject({
      status: "duplicate-warning",
      duplicateMatch: existingMatch,
    });
    expect(mocks.activateSkillDraft).not.toHaveBeenCalled();
  });

  it("activates normally when the recheck finds no similar skill", async () => {
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(null));
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "idle", message: null },
      draftFormData(),
    );

    expect(mocks.activateSkillDraft).toHaveBeenCalledTimes(1);
    expect(mocks.activateSkillDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftFingerprint: "reviewed-draft-fingerprint",
      }),
    );
    expect(result).toMatchObject({
      status: "activated",
      activatedSkillId: "skill-draft",
    });
  });

  it("shows the newly rechecked match instead of accepting a stale override", async () => {
    const changedMatch = {
      ...existingMatch,
      skill: {
        ...existingMatch.skill,
        id: "skill-new-match",
        title: "Choosing Spanish copulas",
        contentFingerprint: "new-match-content-fingerprint",
      },
    };
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(changedMatch));
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      {
        status: "duplicate-warning",
        message: null,
        duplicateMatch: existingMatch,
      },
      draftFormData(existingMatch.skill.id),
    );

    expect(result).toMatchObject({
      status: "duplicate-warning",
      message:
        "LearnRecur found a different similar skill. Compare it before deciding.",
      duplicateMatch: {
        skill: {
          id: "skill-new-match",
        },
      },
    });
    expect(mocks.activateSkillDraft).not.toHaveBeenCalled();
  });

  it("shows a refreshed warning when the same existing skill changed after review", async () => {
    const changedMatch = {
      ...existingMatch,
      skill: {
        ...existingMatch.skill,
        title: "Ser and estar across contexts",
        objective:
          "Choose the copula that fits identity, condition, place, and event prompts.",
        contentFingerprint: "changed-existing-content-fingerprint",
      },
    };
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(changedMatch));
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      {
        status: "duplicate-warning",
        message: null,
        duplicateMatch: existingMatch,
      },
      draftFormData(existingMatch.skill.id),
    );

    expect(result).toMatchObject({
      status: "duplicate-warning",
      message:
        "The saved skill changed after your first comparison. We refreshed it; review and confirm again.",
      duplicateMatch: changedMatch,
    });
    expect(mocks.activateSkillDraft).not.toHaveBeenCalled();
  });

  it("continues activation when the advisory duplicate lookup fails", async () => {
    const privateErrorDetail =
      "private skill text that must never be written to logs";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.findSimilarSkillsForUser.mockRejectedValue(
      new Error(privateErrorDetail),
    );
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "idle", message: null },
      draftFormData(),
    );

    expect(result).toMatchObject({
      status: "activated",
      activatedSkillId: "skill-draft",
    });
    expect(mocks.activateSkillDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDuplicateMatch: undefined,
      }),
    );
    expect(warning).toHaveBeenCalledWith(
      "[skills] duplicate check unavailable",
      {
        userId: "user-alpha",
        skillId: "skill-draft",
        errorName: "Error",
      },
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      privateErrorDetail,
    );
    warning.mockRestore();
  });

  it("refreshes the preview when the reviewed existing skill changes before reservation", async () => {
    const refreshedMatch = {
      ...existingMatch,
      skill: {
        ...existingMatch.skill,
        title: "Updated ser and estar contexts",
        contentFingerprint: "refreshed-existing-content-fingerprint",
      },
    };
    mocks.findSimilarSkillsForUser
      .mockResolvedValueOnce(similarityResult(existingMatch))
      .mockResolvedValueOnce(similarityResult(refreshedMatch));
    mocks.activateSkillDraft.mockResolvedValue({
      status: "not-activated",
      reason: "duplicate-review-changed",
      message: "The existing skill changed after duplicate review.",
    });
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      {
        status: "duplicate-warning",
        message: null,
        duplicateMatch: existingMatch,
      },
      draftFormData(existingMatch.skill.id),
    );

    expect(result).toMatchObject({
      status: "duplicate-warning",
      message:
        "The existing skill changed after you reviewed it. Compare the updated preview before deciding.",
      duplicateMatch: refreshedMatch,
    });
    expect(mocks.findSimilarSkillsForUser).toHaveBeenCalledTimes(2);
  });

  it("returns the learner's latest values when edited input fails validation", async () => {
    mocks.updateSkillDraft.mockResolvedValue({
      status: "invalid",
      message: "Review the highlighted fields.",
      fieldErrors: {
        title: ["Title is required."],
      },
    });
    const formData = draftFormData();
    formData.set("title", "");
    formData.set(
      "objective",
      "Keep this edited objective visible while the title is corrected.",
    );
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "duplicate-warning", message: null, duplicateMatch: existingMatch },
      formData,
    );

    expect(result).toMatchObject({
      status: "error",
      fieldErrors: {
        title: ["Title is required."],
      },
      draftValues: {
        title: "",
        objective:
          "Keep this edited objective visible while the title is corrected.",
        collectionName: "Spanish grammar",
      },
    });
    expect(mocks.findSimilarSkillsForUser).not.toHaveBeenCalled();
    expect(mocks.activateSkillDraft).not.toHaveBeenCalled();
  });

  it("returns the saved values when activation cannot finish", async () => {
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(null));
    mocks.activateSkillDraft.mockResolvedValue({
      status: "not-ready",
      message: "Add at least one verified exercise.",
    });
    const formData = draftFormData();
    formData.set("title", "Edited ser and estar skill");
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "duplicate-warning", message: null, duplicateMatch: existingMatch },
      formData,
    );

    expect(result).toMatchObject({
      status: "saved",
      draftValues: {
        title: "Edited ser and estar skill",
        objective:
          "Choose between ser and estar for identity, location, and temporary state.",
      },
    });
  });

  it("reloads the latest draft when another edit supersedes the reviewed snapshot", async () => {
    mocks.findSimilarSkillsForUser.mockResolvedValue(similarityResult(null));
    mocks.activateSkillDraft.mockResolvedValue({
      status: "not-activated",
      reason: "draft-changed",
      message: "This draft changed after the duplicate check.",
    });
    mocks.findSkillDraftForReview.mockResolvedValue({
      id: "skill-draft",
      title: "Latest title from another tab",
      objective: "Review the newest objective before adding this skill.",
      rules: { items: ["Use the latest rule."] },
      examples: { items: ["Latest example."] },
      exerciseConstraints: { notes: "Use the latest constraints." },
      tags: ["latest"],
      collection: { name: "Latest collection" },
    });
    const { addSkillDraftToPracticeInlineAction } = await import("@/app/skills/actions");

    const result = await addSkillDraftToPracticeInlineAction(
      { status: "idle", message: null },
      draftFormData(),
    );

    expect(result).toMatchObject({
      status: "error",
      message:
        "This draft changed in another tab. Review the latest version, then add it again.",
      draftValues: {
        title: "Latest title from another tab",
        objective: "Review the newest objective before adding this skill.",
        collectionName: "Latest collection",
        rules: "Use the latest rule.",
        examples: "Latest example.",
        exerciseConstraints: "Use the latest constraints.",
        tags: "latest",
      },
    });
  });
});

describe("single-skill duplicate comparison UI", () => {
  it("shows the existing skill preview and all three deliberate paths", async () => {
    const { SkillDuplicateDecision } = await import("@/app/skills/skill-draft-form");
    const markup = renderToStaticMarkup(
      createElement(SkillDuplicateDecision, {
        isSubmitting: false,
        match: existingMatch,
        onKeepEditing: vi.fn(),
        reviewMessage:
          "The existing skill changed. Compare the updated preview before deciding.",
      }),
    );

    expect(markup).toContain('aria-labelledby="');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain("You may already have this skill");
    expect(markup).toContain(
      "The existing skill changed. Compare the updated preview before deciding.",
    );
    expect(markup).toContain("Ser and estar in context");
    expect(markup).toContain(
      "Choose ser or estar for identity, location, and temporary state.",
    );
    expect(markup).toContain("Spanish grammar");
    expect(markup).toContain("spanish");
    expect(markup).toContain("Paused");
    expect(markup).toContain('href="/skills/skill-existing"');
    expect(markup).toContain("Open existing skill");
    expect(markup).toContain("Edit this draft");
    expect(markup).toContain('name="duplicateOverrideSkillId"');
    expect(markup).toContain('value="skill-existing"');
    expect(markup).toContain("Add as a separate skill anyway");
  });
});
