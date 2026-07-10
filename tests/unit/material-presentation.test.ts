import { MaterialRevisionStatus } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";

import { getMaterialAvailabilityMessage } from "@/lib/materials/presentation";

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
