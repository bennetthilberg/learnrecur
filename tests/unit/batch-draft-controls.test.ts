import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@mantine/core", async () => {
  const { createElement: createMockElement } = await import("react");
  return {
    Modal: ({
      children,
      opened,
      title,
    }: {
      children: React.ReactNode;
      opened: boolean;
      title: React.ReactNode;
    }) =>
      createMockElement(
        "section",
        { "data-opened": String(opened), "data-title": title },
        children,
      ),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/skills/skill-draft-form", async () => {
  const { createElement: createMockElement } = await import("react");
  return {
    SkillDraftForm: ({
      initialValues,
      submitIntent,
    }: {
      initialValues: { title: string };
      submitIntent?: string;
    }) =>
      createMockElement(
        "div",
        {
          "data-draft-title": initialValues.title,
          "data-submit-intent": submitIntent,
        },
        "Draft form",
      ),
  };
});

vi.mock("@/app/skills/batches/actions", () => ({
  excludeMaterialDraftItemAction: vi.fn(),
}));

import { BatchDraftEditDialog } from "@/app/skills/batches/batch-draft-edit-dialog";
import { BatchExcludeControl } from "@/app/skills/batches/batch-exclude-control";

const initialValues = {
  title: "Double object pronouns",
  objective: "Use indirect and direct object pronouns together.",
  collectionName: "Spanish grammar",
  rules: "Replace le with se before lo.",
  examples: "Se lo doy.",
  exerciseConstraints: "Use short sentences.",
  tags: "spanish, pronouns",
};

describe("material batch draft controls", () => {
  it("opens draft editing in a save-only modal instead of linking away", () => {
    const markup = renderToStaticMarkup(
      createElement(BatchDraftEditDialog, {
        initialValues,
        skillId: "skill_1",
      }),
    );

    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("Edit draft");
    expect(markup).toContain('data-title="Edit draft"');
    expect(markup).toContain('data-submit-intent="save"');
    expect(markup).toContain('data-draft-title="Double object pronouns"');
    expect(markup).not.toContain('href="/skills/skill_1"');
  });

  it("requires confirmation before excluding a draft", () => {
    const markup = renderToStaticMarkup(
      createElement(BatchExcludeControl, {
        batchId: "batch_1",
        itemId: "item_1",
        title: "Double object pronouns",
      }),
    );

    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain("Exclude");
    expect(markup).toContain('data-title="Exclude this draft?"');
    expect(markup).toContain("This removes the draft from this batch");
    expect(markup).toContain("Confirm exclusion");
  });
});
