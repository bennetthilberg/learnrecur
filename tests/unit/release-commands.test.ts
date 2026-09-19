import { describe, expect, it } from "vitest";

import {
  buildMigrationConnectionUrl,
  getMigrationConnectionUrl,
  getVercelBuildSteps,
} from "../../scripts/lib/release-commands";

describe("release commands", () => {
  it("runs migrations before production Vercel builds", () => {
    expect(getVercelBuildSteps("production")).toEqual([
      {
        label: "release prebuild",
        command: "npm",
        args: ["run", "prebuild"],
      },
      { label: "database migrations", command: "npm", args: ["run", "prisma:deploy"] },
      { label: "application build", command: "npm", args: ["exec", "--", "next", "build"] },
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

  it("falls back to DATABASE_URL when DIRECT_URL is blank", () => {
    expect(
      getMigrationConnectionUrl({
        DIRECT_URL: "  ",
        DATABASE_URL: " postgres://runtime:secret@localhost:5432/app ",
      }),
    ).toBe("postgres://runtime:secret@localhost:5432/app");
  });

  it("prefers a non-blank DIRECT_URL for migrations", () => {
    expect(
      getMigrationConnectionUrl({
        DIRECT_URL: " postgres://migrate:secret@localhost:5432/app ",
        DATABASE_URL: "postgres://runtime:secret@localhost:5432/app",
      }),
    ).toBe("postgres://migrate:secret@localhost:5432/app");
  });

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
