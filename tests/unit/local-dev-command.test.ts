import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

describe("local development command", () => {
  it("starts Next.js and the local SQS worker together", () => {
    const devCommand = packageJson.scripts?.dev ?? "";

    expect(devCommand).toContain("concurrently");
    expect(devCommand).toContain("next dev");
    expect(devCommand).toContain("npm run jobs:dev");
    expect(packageJson.scripts?.["jobs:dev"]).toContain("scripts/jobs-dev.ts");
  });
});
