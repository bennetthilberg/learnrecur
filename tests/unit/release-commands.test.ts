import { describe, expect, it } from "vitest";

import {
  buildMigrationConnectionUrl,
  getVercelBuildSteps,
} from "../../scripts/lib/release-commands";

describe("release commands", () => {
  it("runs migrations before production Vercel builds", () => {
    expect(getVercelBuildSteps("production")).toEqual([
      { label: "production environment validation", command: "npm", args: ["run", "env:check"] },
      { label: "database migrations", command: "npm", args: ["run", "prisma:deploy"] },
      { label: "application build", command: "npm", args: ["run", "build"] },
    ]);
  });

  it.each([undefined, "preview", "development"])(
    "does not migrate hosted databases for %s builds",
    (environment) => {
      expect(getVercelBuildSteps(environment)).toEqual([
        { label: "application build", command: "npm", args: ["run", "build"] },
      ]);
    },
  );

  it("upgrades RDS migration connections to verified TLS", () => {
    const result = new URL(
      buildMigrationConnectionUrl(
        "postgres://user:password@db.cluster.us-east-1.rds.amazonaws.com/app?sslmode=require&application_name=release",
        "/tmp/learnrecur rds-ca.pem",
      ),
    );

    expect(result.searchParams.get("sslmode")).toBe("verify-full");
    expect(result.searchParams.get("sslrootcert")).toBe("/tmp/learnrecur rds-ca.pem");
    expect(result.searchParams.get("application_name")).toBe("release");
  });

  it("uses system roots for other remote PostgreSQL hosts", () => {
    const result = new URL(
      buildMigrationConnectionUrl(
        "postgres://user:password@db.example.com/app?sslmode=require",
        "/tmp/rds-ca.pem",
      ),
    );

    expect(result.searchParams.get("sslmode")).toBe("verify-full");
    expect(result.searchParams.has("sslrootcert")).toBe(false);
  });

  it("preserves explicitly unencrypted loopback connections for CI", () => {
    const connectionUrl = "postgres://postgres:postgres@localhost:5432/test?sslmode=disable";
    expect(buildMigrationConnectionUrl(connectionUrl, "/tmp/rds-ca.pem")).toBe(connectionUrl);
  });

  it("rejects non-PostgreSQL connection URLs", () => {
    expect(() =>
      buildMigrationConnectionUrl("https://db.example.com/app", "/tmp/rds-ca.pem"),
    ).toThrow("PostgreSQL connection URL");
  });

  it.each(["disable", "no-verify"])(
    "rejects remote migration URLs that disable certificate verification with %s",
    (sslmode) => {
      expect(() =>
        buildMigrationConnectionUrl(
          `postgres://user:password@db.example.com/app?sslmode=${sslmode}`,
          "/tmp/rds-ca.pem",
        ),
      ).toThrow("verified TLS");
    },
  );
});
