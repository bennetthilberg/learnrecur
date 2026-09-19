const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const INSECURE_SSL_MODES = new Set(["disable", "no-verify"]);
const POSTGRES_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const RDS_US_EAST_1_SUFFIX = ".us-east-1.rds.amazonaws.com";

export type ReleaseCommand = Readonly<{
  label: string;
  command: "npm";
  args: readonly string[];
}>;

export function getVercelBuildSteps(environment: string | undefined): ReleaseCommand[] {
  const build: ReleaseCommand = {
    label: "application build",
    command: "npm",
    args: ["run", "build"],
  };

  if (environment !== "production") {
    return [build];
  }

  return [
    {
      label: "release prebuild",
      command: "npm",
      args: ["run", "prebuild"],
    },
    {
      label: "database migrations",
      command: "npm",
      args: ["run", "prisma:deploy"],
    },
    {
      label: "application build",
      command: "npm",
      args: ["exec", "--", "next", "build"],
    },
  ];
}

export function getMigrationConnectionUrl(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return [environment.DIRECT_URL, environment.DATABASE_URL]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

export function buildMigrationConnectionUrl(
  connectionUrl: string,
  rootCertificatePath: string,
): string {
  const url = new URL(connectionUrl);

  if (!POSTGRES_PROTOCOLS.has(url.protocol)) {
    throw new Error("Database migrations require a PostgreSQL connection URL.");
  }
  if (LOOPBACK_HOSTS.has(url.hostname)) {
    return connectionUrl;
  }

  const sslmode = url.searchParams.get("sslmode");
  if (sslmode && INSECURE_SSL_MODES.has(sslmode)) {
    throw new Error("Remote database migrations require verified TLS.");
  }

  for (const key of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    url.searchParams.delete(key);
  }
  url.searchParams.set("sslmode", "verify-full");

  if (url.hostname.endsWith(RDS_US_EAST_1_SUFFIX)) {
    url.searchParams.set("sslrootcert", rootCertificatePath);
  }

  return url.toString();
}
