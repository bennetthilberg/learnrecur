import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/production-health.yml", import.meta.url), "utf8");
const validation = workflow.split("      - name: Validate probe target\n")[1].split("      - name: Check liveness\n")[0].split("        run: |\n")[1];
const candidate = "https://learnrecur-verified123-learn-recur.vercel.app";

it.each([
  ["https://alpha.learnrecur.com", "", 0],
  [candidate, candidate, 0],
  [candidate, "", 1],
  ["https://learnrecur-untrusted123-learn-recur.vercel.app", candidate, 1],
  ["https://attacker.example", "https://attacker.example", 1],
  [`${candidate}/redirect`, `${candidate}/redirect`, 1],
])("checks the exact trusted destination before allowing probes to %s", (url, trusted, expected) => {
  const result = spawnSync("bash", ["-c", validation], { env: { ...process.env, PRODUCTION_URL: url, TRUSTED_CANDIDATE_URL: trusted, DEPLOYMENT_BYPASS_SECRET: "private-fixture-must-not-be-printed" }, encoding: "utf8" });
  expect(result.status === 0 ? 0 : 1).toBe(expected);
  expect(result.stdout + result.stderr).not.toContain("private-fixture-must-not-be-printed");
});
