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
  it("uses more of the wide-screen canvas for both scope cards", () => {
    expect(styles).toMatch(
      /\.batchStageRail,[\s\S]*?\.batchActivationBar,[\s\S]*?max-width:\s*1120px;/,
    );
    expect(styles).toMatch(
      /\.batchShell \.materialHeader\s*\{[^}]*max-width:\s*1120px;/s,
    );
    expect(styles).toMatch(
      /\.batchScopeLayout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+400px;/s,
    );
  });

  it("does not override primary button label contrast inside the confirmation bar", () => {
    expect(styles).toContain(".batchConfirmBar > span {");
    expect(styles).not.toContain(".batchConfirmBar span {");
    expect(styles).toContain(".batchActivationBar > div > span {");
    expect(styles).not.toContain(".batchActivationBar span {");
  });

  it("aligns the generating spinner with the notice heading", () => {
    expect(styles).toMatch(
      /\.batchGeneratingNotice\s*>\s*\.materialProcessingPulse\s*\{[^}]*margin-top:\s*4px;/s,
    );
  });

  it("uses concise retry copy for scope changes", () => {
    expect(batchPage).toMatch(/<BatchSubmitButton className="secondaryButton">\s*Try again\s*</s);
    expect(batchPage).not.toContain("Resolve again");
  });

  it("keeps draft editing and exclusion in confirmed modal flows", () => {
    expect(batchPage).toContain("<BatchDraftEditDialog");
    expect(batchPage).toContain("<BatchExcludeControl");
    expect(batchPage).not.toContain('href={`/skills/${item.skill.id}`}>\n                    Edit draft');
  });
});
