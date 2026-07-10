import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

describe("Next.js server packaging", () => {
  it("keeps PDF.js external so its Node worker remains resolvable", () => {
    expect(nextConfig.serverExternalPackages).toContain("pdfjs-dist");
  });
});
