import { expect, it } from "vitest";
import { skillOrganizationSchema } from "@/lib/forms/skill-organization";

it("validates names and only accepts the field selected by the action", () => {
  expect(skillOrganizationSchema.parse({ mode: "rename", title: "  Spanish verbs  ", collectionId: "ignored" })).toEqual({ mode: "rename", title: "Spanish verbs" });
  expect(skillOrganizationSchema.safeParse({ mode: "rename", title: "   " }).success).toBe(false);
  expect(skillOrganizationSchema.safeParse({ mode: "rename", title: "a".repeat(121) }).success).toBe(false);
  expect(skillOrganizationSchema.parse({ mode: "move", collectionId: null, title: "ignored" })).toEqual({ mode: "move", collectionId: null });
  expect(skillOrganizationSchema.safeParse({ mode: "delete", collectionId: null }).success).toBe(false);
});
