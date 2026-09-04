import { describe, expect, it } from "vitest";

import {
  classifyDependencyNode,
  evaluateRuntimeAudit,
  osvSeverity,
  type NpmAuditReport,
  type NpmLockfile,
  type PackageManifest,
  type RuntimeAuditException,
} from "../../scripts/check-runtime-audit";

const manifest: PackageManifest = {
  dependencies: { app: "1.0.0" },
  devDependencies: { cli: "1.0.0" },
};

const lockfile: NpmLockfile = {
  packages: {
    "": {
      dependencies: { app: "1.0.0" },
      devDependencies: { cli: "1.0.0" },
    },
    "node_modules/app": {
      dependencies: { runtimeLeaf: "1.0.0" },
    },
    "node_modules/runtimeLeaf": {},
    "node_modules/cli": {
      dependencies: { cliLeaf: "1.0.0" },
    },
    "node_modules/cliLeaf": {
      devOptional: true,
    },
  },
};

function advisoryReport(
  packageName: string,
  severity: "low" | "moderate" | "high" | "critical",
  advisoryId: string,
  node = `node_modules/${packageName}`,
): NpmAuditReport {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      [packageName]: {
        name: packageName,
        severity,
        isDirect: false,
        via: [
          {
            source: 123,
            name: packageName,
            dependency: packageName,
            title: `${advisoryId} test advisory`,
            url: `https://github.com/advisories/${advisoryId}`,
            severity,
            range: "<2.0.0",
          },
        ],
        effects: [],
        nodes: [node],
      },
    },
  };
}

const activeException: RuntimeAuditException = {
  advisoryId: "GHSA-test-1234-5678",
  packageName: "cliLeaf",
  rationale: "CLI-only test dependency with no production import path.",
  ownerRole: "release engineering",
  expiresAt: "2026-10-03T23:59:59.999Z",
};

describe("runtime dependency audit policy", () => {
  it("classifies vector-only OSV severity with a CVSS parser", () => {
    expect(
      osvSeverity({
        severity: [
          {
            score: "CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:N/I:L/A:N",
          },
        ],
      }),
    ).toBe("moderate");
    expect(
      osvSeverity({
        severity: [
          {
            score:
              "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
          },
        ],
      }),
    ).toBe("critical");
  });

  it("fails closed when OSV severity cannot be parsed", () => {
    expect(osvSeverity({ severity: [{ score: "not-a-cvss-vector" }] })).toBe("high");
  });

  it("classifies a production-reachable package as runtime even when npm marks it devOptional", () => {
    const productionMarkedPackage: NpmLockfile = {
      packages: {
        ...lockfile.packages,
        "node_modules/app": {
          dependencies: { runtimeLeaf: "1.0.0" },
        },
        "node_modules/runtimeLeaf": { devOptional: true },
      },
    };

    expect(
      classifyDependencyNode("node_modules/runtimeLeaf", manifest, productionMarkedPackage),
    ).toBe("runtime");
  });

  it("classifies a package reachable only from a development root as dev-only", () => {
    expect(classifyDependencyNode("node_modules/cliLeaf", manifest, lockfile)).toBe("dev-only");
  });

  it("accepts an active, exact advisory exception for a dev-only high finding", () => {
    const report = advisoryReport(
      "cliLeaf",
      "high",
      activeException.advisoryId,
    );

    const result = evaluateRuntimeAudit(report, {
      manifest,
      lockfile,
      now: new Date("2026-09-03T12:00:00.000Z"),
      exceptions: [activeException],
    });

    expect(result.passed).toBe(true);
    expect(result.accepted).toHaveLength(1);
    expect(result.blocking).toHaveLength(0);
  });

  it("fails an unexcepted high runtime finding", () => {
    const result = evaluateRuntimeAudit(
      advisoryReport("runtimeLeaf", "high", "GHSA-new-runtime-1234-5678"),
      { manifest, lockfile, now: new Date("2026-09-03T12:00:00.000Z"), exceptions: [] },
    );

    expect(result.passed).toBe(false);
    expect(result.blocking.some((issue) => issue.message.includes("runtime high/critical"))).toBe(
      true,
    );
  });

  it("fails an expired exception even when it matches the advisory", () => {
    const expiredException = {
      ...activeException,
      expiresAt: "2026-09-02T23:59:59.999Z",
    };
    const result = evaluateRuntimeAudit(
      advisoryReport("cliLeaf", "high", expiredException.advisoryId),
      {
        manifest,
        lockfile,
        now: new Date("2026-09-03T12:00:00.000Z"),
        exceptions: [expiredException],
      },
    );

    expect(result.passed).toBe(false);
    expect(result.blocking.some((issue) => issue.message.includes("expired"))).toBe(true);
  });

  it("does not let a CLI exception mask the same advisory on a runtime path", () => {
    const runtimeException = {
      ...activeException,
      packageName: "runtimeLeaf",
    };
    const result = evaluateRuntimeAudit(
      advisoryReport("runtimeLeaf", "high", runtimeException.advisoryId),
      {
        manifest,
        lockfile,
        now: new Date("2026-09-03T12:00:00.000Z"),
        exceptions: [runtimeException],
      },
    );

    expect(result.passed).toBe(false);
    expect(
      result.blocking.some((issue) => issue.message.includes("only valid for dev-only")),
    ).toBe(true);
  });
});
