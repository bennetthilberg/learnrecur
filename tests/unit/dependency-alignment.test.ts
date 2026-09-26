import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { overrides: Record<string, string> };
const reactNativeCliPlugin = JSON.parse(
  readFileSync(
    new URL("../../node_modules/@react-native/community-cli-plugin/package.json", import.meta.url),
    "utf8",
  ),
) as { dependencies: { metro: string } };

describe("dependency alignment", () => {
  it("keeps Metro overrides within React Native's declared Metro line", () => {
    const requiredLine = /^\^(\d+\.\d+)\./.exec(reactNativeCliPlugin.dependencies.metro)?.[1];
    expect(requiredLine).toBeDefined();

    for (const dependency of ["metro", "metro-config", "metro-transform-worker"]) {
      expect(manifest.overrides[dependency]?.startsWith(`${requiredLine}.`)).toBe(true);
    }
  });
});
