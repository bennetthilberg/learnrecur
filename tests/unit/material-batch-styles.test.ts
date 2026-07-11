import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../../src/app/open-water.css", import.meta.url),
  "utf8",
);
const batchPage = readFileSync(
  new URL("../../src/app/skills/batches/[batchId]/page.tsx", import.meta.url),
  "utf8",
);

describe("material batch presentation", () => {
  it("gives the correction form a useful desktop width", () => {
    expect(styles).toMatch(
      /\.batchScopeLayout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+340px;/s,
    );
  });

  it("does not override primary button label contrast inside the confirmation bar", () => {
    expect(styles).toContain(".batchConfirmBar > span {");
    expect(styles).not.toContain(".batchConfirmBar span {");
  });

  it("uses concise retry copy for scope changes", () => {
    expect(batchPage).toMatch(/<BatchSubmitButton className="secondaryButton">\s*Try again\s*</s);
    expect(batchPage).not.toContain("Resolve again");
  });
});
