import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

describe("local development command", () => {
  it("starts Next.js and the Inngest dev server together", () => {
    const devCommand = packageJson.scripts?.dev ?? "";

    expect(devCommand).toContain("concurrently");
    expect(devCommand).toContain("next dev");
    expect(devCommand).toContain("inngest dev");
    expect(devCommand).toContain("http://localhost:3000/api/inngest");
  });
});
