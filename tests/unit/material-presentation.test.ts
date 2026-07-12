import { MaterialRevisionStatus } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";

import {
  getMaterialBatchActivationCopy,
  getMaterialDraftItemErrorMessage,
  getMaterialAvailabilityMessage,
  getPublicMaterialActionErrorMessage,
} from "@/lib/materials/presentation";

describe("material availability messages", () => {
  it("tells the user when a material can create skills", () => {
    expect(
      getMaterialAvailabilityMessage({
        hasReadyRevision: true,
        stalled: false,
        status: MaterialRevisionStatus.READY,
      }),
    ).toEqual({
      title: "Ready to create skills",
      description: "Choose any section from this material to start creating skills.",
      tone: "ready",
    });
  });

  it("explains that first-time processing blocks skill creation", () => {
    expect(
      getMaterialAvailabilityMessage({
        hasReadyRevision: false,
        stalled: false,
        status: MaterialRevisionStatus.PROCESSING,
      }),
    ).toEqual({
      title: "Preparing your material",
      description: "You can create skills as soon as the outline is ready.",
      tone: "working",
    });
  });

  it("preserves creation access while a website refresh is processing", () => {
    expect(
      getMaterialAvailabilityMessage({
        hasReadyRevision: true,
        stalled: false,
        status: MaterialRevisionStatus.PROCESSING,
      }),
    ).toEqual({
      title: "Update in progress",
      description:
        "You can keep creating skills from the current version while the update finishes.",
      tone: "working",
    });
  });

  it("gives a specific next step when processing stalled", () => {
    expect(
      getMaterialAvailabilityMessage({
        hasReadyRevision: false,
        stalled: true,
        status: MaterialRevisionStatus.QUEUED,
      }),
    ).toEqual({
      title: "Processing needs attention",
      description: "Retry processing before you can create skills from this material.",
      tone: "attention",
    });
  });
});

describe("material action error messages", () => {
  it("replaces serialized provider errors from stale query strings", () => {
    const legacyProviderError = JSON.stringify({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
      },
    });

    expect(
      getPublicMaterialActionErrorMessage(
        legacyProviderError,
        "LearnRecur could not review that scope. Check the request and try again.",
      ),
    ).toBe("LearnRecur could not review that scope. Check the request and try again.");
  });

  it("preserves concise user-facing action errors", () => {
    expect(
      getPublicMaterialActionErrorMessage(
        "The selected skill could not be added.",
        "LearnRecur could not update this batch. Try again.",
      ),
    ).toBe("The selected skill could not be added.");
  });
});

describe("material draft item error messages", () => {
  it("replaces legacy queue failure copy with an actionable explanation", () => {
    expect(
      getMaterialDraftItemErrorMessage(
        "EVENT_SEND_FAILED",
        "Draft generation could not be queued. Retry this item.",
      ),
    ).toBe("Background processing was unavailable. Retry this item.");
  });

  it("preserves other item errors", () => {
    expect(
      getMaterialDraftItemErrorMessage(
        "DRAFT_GENERATION_FAILED",
        "The draft could not be verified.",
      ),
    ).toBe("The draft could not be verified.");
  });
});

describe("material batch activation copy", () => {
  it.each([
    [1, { actionLabel: "Add one skill", countLabel: "1 skill ready to add" }],
    [2, { actionLabel: "Add all 2", countLabel: "2 skills ready to add" }],
    [10, { actionLabel: "Add all 10", countLabel: "10 skills ready to add" }],
  ])("uses grammatical copy for %i ready skills", (readyCount, expected) => {
    expect(getMaterialBatchActivationCopy(readyCount)).toEqual(expected);
  });
});
