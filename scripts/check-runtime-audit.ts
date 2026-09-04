import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DependencyScope = "runtime" | "dev-only" | "unknown";
export type AuditSeverity = "info" | "low" | "moderate" | "high" | "critical";

export interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface NpmLockPackage {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  dev?: boolean;
  devOptional?: boolean;
}

export interface NpmLockfile {
  packages?: Record<string, NpmLockPackage>;
}

export interface NpmAuditAdvisory {
  source?: number | string;
  name?: string;
  dependency?: string;
  title?: string;
  url?: string;
  severity?: string;
  range?: string;
}

export interface NpmAuditVulnerability {
  name: string;
  severity: string;
  isDirect?: boolean;
  via?: Array<string | NpmAuditAdvisory>;
  effects?: string[];
  nodes?: string[];
}

export interface NpmAuditReport {
  auditReportVersion?: number;
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: Record<string, number>;
    dependencies?: Record<string, number>;
  };
}

export interface RuntimeAuditException {
  advisoryId: string;
  packageName: string;
  rationale: string;
  ownerRole: string;
  expiresAt: string;
}

export interface RuntimeAuditFinding {
  advisoryId: string;
  packageName: string;
  severity: AuditSeverity;
  title: string;
  url?: string;
  nodes: string[];
  scope: DependencyScope;
  disposition: "accepted-exception" | "non-blocking" | "blocking";
  exception?: RuntimeAuditException;
}

export interface RuntimeAuditIssue {
  message: string;
  finding?: RuntimeAuditFinding;
}

export interface RuntimeAuditEvaluation {
  findings: RuntimeAuditFinding[];
  accepted: RuntimeAuditFinding[];
  nonBlocking: RuntimeAuditFinding[];
  blocking: RuntimeAuditIssue[];
  passed: boolean;
}

const HIGH_RISK_SEVERITIES = new Set<AuditSeverity>(["high", "critical"]);
const OSV_QUERY_BATCH_SIZE = 500;
const OSV_REQUEST_TIMEOUT_MS = 30_000;

// These are the four concrete advisories reported today. They are only
// accepted while the affected node remains dev-only and before this review
// date. Prisma 7.8.0 is retained because npm's proposed Prisma 6.19.3 fix is
// a major downgrade, not a compatible remediation.
export const RUNTIME_AUDIT_EXCEPTIONS: readonly RuntimeAuditException[] = [
  {
    advisoryId: "GHSA-ggr8-5vv4-36mx",
    packageName: "deepmerge-ts",
    rationale:
      "Prisma 7 CLI configuration dependency only; the app runtime does not import the Prisma CLI path. npm proposes Prisma 6.19.3, a major downgrade, so retain Prisma 7 and recheck on the next dependency review.",
    ownerRole: "release engineering",
    expiresAt: "2026-10-03T23:59:59.999Z",
  },
  {
    advisoryId: "GHSA-3f6p-5ww8-9rcr",
    packageName: "mysql2",
    rationale:
      "MySQL2 is present only beneath the Prisma 7 CLI and is not used by the Neon production adapter. npm proposes Prisma 6.19.3, a major downgrade, so retain Prisma 7 and recheck on the next dependency review.",
    ownerRole: "release engineering",
    expiresAt: "2026-10-03T23:59:59.999Z",
  },
  {
    advisoryId: "GHSA-rgwj-5xj2-c3m3",
    packageName: "mysql2",
    rationale:
      "MySQL2 is present only beneath the Prisma 7 CLI and is not used by the Neon production adapter. npm proposes Prisma 6.19.3, a major downgrade, so retain Prisma 7 and recheck on the next dependency review.",
    ownerRole: "release engineering",
    expiresAt: "2026-10-03T23:59:59.999Z",
  },
  {
    advisoryId: "GHSA-5qjj-4xww-7phc",
    packageName: "valibot",
    rationale:
      "Valibot is used by Prisma's development tooling only; it is not on the app runtime import path. npm proposes Prisma 6.19.3, a major downgrade, so retain Prisma 7 and recheck on the next dependency review.",
    ownerRole: "release engineering",
    expiresAt: "2026-10-03T23:59:59.999Z",
  },
];

function packageNode(packageName: string): string {
  return `node_modules/${packageName}`;
}

function resolveDependencyNode(
  parentNode: string,
  dependencyName: string,
  packages: Record<string, NpmLockPackage>,
): string | undefined {
  let searchParent: string | undefined = parentNode;

  while (searchParent !== undefined) {
    const candidate = searchParent
      ? `${searchParent}/node_modules/${dependencyName}`
      : packageNode(dependencyName);

    if (packages[candidate]) {
      return candidate;
    }

    const parentMarker = searchParent.lastIndexOf("/node_modules/");
    searchParent = parentMarker >= 0 ? searchParent.slice(0, parentMarker) : undefined;
  }

  const rootCandidate = packageNode(dependencyName);
  return packages[rootCandidate] ? rootCandidate : undefined;
}

function dependencyNames(lockPackage: NpmLockPackage): string[] {
  return [
    ...new Set([
      ...Object.keys(lockPackage.dependencies ?? {}),
      ...Object.keys(lockPackage.optionalDependencies ?? {}),
    ]),
  ];
}

function collectReachableNodes(
  rootNames: string[],
  lockfile: NpmLockfile,
): Set<string> {
  const packages = lockfile.packages ?? {};
  const reachable = new Set<string>();
  const pending = rootNames
    .map(packageNode)
    .filter((node) => packages[node] !== undefined);

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || reachable.has(node)) {
      continue;
    }

    const lockPackage = packages[node];
    if (!lockPackage) {
      continue;
    }

    reachable.add(node);

    for (const dependencyName of dependencyNames(lockPackage)) {
      const dependencyNode = resolveDependencyNode(node, dependencyName, packages);
      if (dependencyNode && !reachable.has(dependencyNode)) {
        pending.push(dependencyNode);
      }
    }
  }

  return reachable;
}

/**
 * Classify an npm-audit node from the manifest roots and lockfile edges.
 *
 * Peer dependencies are deliberately not treated as runtime code edges. A
 * production package can declare a development CLI as an optional peer (as
 * @prisma/client does for prisma), but the CLI is not imported by the app.
 * Direct production roots and their installed dependencies still win over
 * devOptional metadata, so a package reachable from production is never
 * hidden by a shared dev tree.
 */
export function classifyDependencyNode(
  node: string,
  manifest: PackageManifest,
  lockfile: NpmLockfile,
): DependencyScope {
  const runtimeRoots = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
  const developmentRoots = Object.keys(manifest.devDependencies ?? {});
  const runtimeNodes = collectReachableNodes(runtimeRoots, lockfile);
  const developmentNodes = collectReachableNodes(developmentRoots, lockfile);

  if (runtimeNodes.has(node)) {
    return "runtime";
  }

  if (developmentNodes.has(node)) {
    return "dev-only";
  }

  const lockPackage = lockfile.packages?.[node];
  if (lockPackage?.dev === true || lockPackage?.devOptional === true) {
    return "dev-only";
  }

  return "unknown";
}

function isAdvisory(value: string | NpmAuditAdvisory): value is NpmAuditAdvisory {
  return typeof value === "object" && value !== null;
}

function advisoryId(advisory: NpmAuditAdvisory): string {
  for (const value of [advisory.url, advisory.title, String(advisory.source ?? "")]) {
    const match = value?.match(/GHSA-[A-Z0-9-]+/i);
    if (match) {
      return match[0].toUpperCase();
    }
  }

  return advisory.source === undefined ? "unknown-advisory" : `npm-${advisory.source}`;
}

function normalizedSeverity(value: string | undefined): AuditSeverity {
  switch (value?.toLowerCase()) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "moderate":
      return "moderate";
    case "low":
      return "low";
    default:
      return "info";
  }
}

function concreteAdvisoryExists(
  packageName: string,
  vulnerabilities: Record<string, NpmAuditVulnerability>,
  visiting = new Set<string>(),
): boolean {
  if (visiting.has(packageName)) {
    return false;
  }

  const vulnerability = vulnerabilities[packageName];
  if (!vulnerability) {
    return false;
  }

  const via = vulnerability.via ?? [];
  if (via.some(isAdvisory)) {
    return true;
  }

  const nextVisiting = new Set(visiting).add(packageName);
  const references = via.filter((value): value is string => typeof value === "string");

  return (
    references.length > 0 &&
    references.every((reference) =>
      concreteAdvisoryExists(reference, vulnerabilities, nextVisiting),
    )
  );
}

function auditFindings(
  report: NpmAuditReport,
  manifest: PackageManifest,
  lockfile: NpmLockfile,
): RuntimeAuditFinding[] {
  const vulnerabilities = report.vulnerabilities ?? {};
  const findings: RuntimeAuditFinding[] = [];
  const seen = new Set<string>();

  for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
    const advisories = (vulnerability.via ?? []).filter(isAdvisory);
    const nodes = vulnerability.nodes?.length
      ? vulnerability.nodes
      : [packageNode(packageName)];

    for (const advisory of advisories) {
      const finding: RuntimeAuditFinding = {
        advisoryId: advisoryId(advisory),
        packageName,
        severity: normalizedSeverity(advisory.severity ?? vulnerability.severity),
        title: advisory.title ?? `${packageName} advisory`,
        url: advisory.url,
        nodes,
        scope: nodes.some(
          (node) => classifyDependencyNode(node, manifest, lockfile) === "runtime",
        )
          ? "runtime"
          : nodes.some(
                (node) => classifyDependencyNode(node, manifest, lockfile) === "unknown",
              )
            ? "unknown"
            : "dev-only",
        disposition: "blocking",
      };
      const key = `${finding.advisoryId}:${finding.packageName}:${finding.nodes.join(",")}`;

      if (!seen.has(key)) {
        seen.add(key);
        findings.push(finding);
      }
    }

    // npm represents package-level roll-ups (for example prisma and
    // @prisma/config) with string references in `via`. They are covered by
    // their concrete leaf advisory when every reference resolves to one. A
    // high/critical roll-up with no concrete leaf is a real policy finding,
    // not something this script may silently discard.
    if (
      advisories.length === 0 &&
      HIGH_RISK_SEVERITIES.has(normalizedSeverity(vulnerability.severity)) &&
      !concreteAdvisoryExists(packageName, vulnerabilities)
    ) {
      findings.push({
        advisoryId: `package:${packageName}`,
        packageName,
        severity: normalizedSeverity(vulnerability.severity),
        title: `Unresolved npm audit finding for ${packageName}`,
        nodes,
        scope: nodes.some(
          (node) => classifyDependencyNode(node, manifest, lockfile) === "runtime",
        )
          ? "runtime"
          : nodes.some(
                (node) => classifyDependencyNode(node, manifest, lockfile) === "unknown",
              )
            ? "unknown"
            : "dev-only",
        disposition: "blocking",
      });
    }
  }

  return findings.sort((left, right) =>
    `${left.packageName}:${left.advisoryId}`.localeCompare(
      `${right.packageName}:${right.advisoryId}`,
    ),
  );
}

function exceptionKey(exception: RuntimeAuditException): string {
  return `${exception.advisoryId.toUpperCase()}:${exception.packageName}`;
}

function validateExceptions(
  exceptions: readonly RuntimeAuditException[],
  now: Date,
): { issues: RuntimeAuditIssue[]; problems: Map<string, string> } {
  const issues: RuntimeAuditIssue[] = [];
  const problems = new Map<string, string>();

  for (const exception of exceptions) {
    const key = exceptionKey(exception);
    const missingFields = [
      ["advisory ID", exception.advisoryId],
      ["package name", exception.packageName],
      ["rationale", exception.rationale],
      ["owner role", exception.ownerRole],
      ["expiry", exception.expiresAt],
    ].filter(([, value]) => !value?.trim());

    if (missingFields.length > 0) {
      const message = `audit exception ${key} is missing ${missingFields
        .map(([field]) => field)
        .join(", ")}`;
      problems.set(key, message);
      issues.push({ message });
      continue;
    }

    const expiry = Date.parse(exception.expiresAt);
    if (Number.isNaN(expiry)) {
      const message = `audit exception ${key} has an invalid expiry ${exception.expiresAt}`;
      problems.set(key, message);
      issues.push({ message });
      continue;
    }

    if (expiry <= now.getTime()) {
      const message = `audit exception ${key} expired at ${exception.expiresAt}`;
      problems.set(key, message);
      issues.push({ message });
    }
  }

  return { issues, problems };
}

export interface EvaluateRuntimeAuditOptions {
  manifest: PackageManifest;
  lockfile: NpmLockfile;
  now?: Date;
  exceptions?: readonly RuntimeAuditException[];
}

export function evaluateRuntimeAudit(
  report: NpmAuditReport,
  options: EvaluateRuntimeAuditOptions,
): RuntimeAuditEvaluation {
  const now = options.now ?? new Date();
  const exceptions = options.exceptions ?? RUNTIME_AUDIT_EXCEPTIONS;
  const findings = auditFindings(report, options.manifest, options.lockfile);
  const validation = validateExceptions(exceptions, now);
  const blocking = [...validation.issues];
  const accepted: RuntimeAuditFinding[] = [];
  const nonBlocking: RuntimeAuditFinding[] = [];

  for (const finding of findings) {
    const exception = exceptions.find(
      (candidate) =>
        candidate.advisoryId.toUpperCase() === finding.advisoryId &&
        candidate.packageName === finding.packageName,
    );

    if (exception) {
      finding.exception = exception;
      const exceptionProblem = validation.problems.get(exceptionKey(exception));

      if (exceptionProblem) {
        finding.disposition = "blocking";
        continue;
      }

      if (finding.scope !== "dev-only") {
        finding.disposition = "blocking";
        blocking.push({
          message: `audit exception ${exceptionKey(
            exception,
          )} is only valid for dev-only findings; observed ${finding.scope}`,
          finding,
        });
        continue;
      }

      finding.disposition = "accepted-exception";
      accepted.push(finding);
      continue;
    }

    if (finding.scope === "runtime" && HIGH_RISK_SEVERITIES.has(finding.severity)) {
      finding.disposition = "blocking";
      blocking.push({
        message: `runtime high/critical advisory ${finding.advisoryId} affects ${finding.packageName}`,
        finding,
      });
      continue;
    }

    if (finding.scope === "dev-only") {
      finding.disposition = "blocking";
      blocking.push({
        message: `dev-only advisory ${finding.advisoryId} for ${finding.packageName} has no explicit time-bounded exception`,
        finding,
      });
      continue;
    }

    if (finding.scope === "unknown") {
      finding.disposition = "blocking";
      blocking.push({
        message: `could not classify npm audit advisory ${finding.advisoryId} for ${finding.packageName}`,
        finding,
      });
      continue;
    }

    finding.disposition = "non-blocking";
    nonBlocking.push(finding);
  }

  return {
    findings,
    accepted,
    nonBlocking,
    blocking,
    passed: blocking.length === 0,
  };
}

function formatFinding(finding: RuntimeAuditFinding): string {
  const nodes = finding.nodes.join(", ");
  const base = `${finding.advisoryId} [${finding.severity}] ${finding.packageName} (${finding.scope}; ${nodes})`;

  if (finding.disposition === "accepted-exception" && finding.exception) {
    return `${base} -> ACCEPTED through ${finding.exception.expiresAt} by ${finding.exception.ownerRole}: ${finding.exception.rationale}${finding.url ? ` ${finding.url}` : ""}`;
  }

  return `${base} -> ${finding.disposition.toUpperCase()}${finding.url ? ` ${finding.url}` : ""}`;
}

export function formatRuntimeAuditResult(evaluation: RuntimeAuditEvaluation): string {
  const lines = ["Runtime dependency audit (OSV package-version queries)", ""];

  if (evaluation.findings.length === 0) {
    lines.push("No advisories reported.");
  } else {
    lines.push(...evaluation.findings.map(formatFinding));
  }

  lines.push(
    "",
    `Summary: ${evaluation.accepted.length} accepted exception(s), ${evaluation.nonBlocking.length} non-blocking runtime finding(s), ${evaluation.blocking.length} blocking issue(s).`,
    evaluation.passed ? "Result: PASS" : "Result: FAIL",
  );

  if (evaluation.blocking.length > 0) {
    lines.push("", "Blocking issues:", ...evaluation.blocking.map((issue) => `- ${issue.message}`));
  }

  return lines.join("\n");
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

type OsvQuery = {
  package: { ecosystem: "npm"; name: string };
  version: string;
};

type OsvBatchResult = {
  vulns?: Array<{ id?: unknown }>;
  next_page_token?: unknown;
};

type OsvVulnerability = {
  id?: unknown;
  aliases?: unknown;
  summary?: unknown;
  database_specific?: { severity?: unknown };
  severity?: Array<{ score?: unknown }>;
};

function lockPackageName(node: string, value: NpmLockPackage): string | null {
  if (value.name) return value.name;
  const marker = node.lastIndexOf("node_modules/");
  if (marker < 0) return null;
  const remainder = node.slice(marker + "node_modules/".length);
  if (!remainder) return null;
  const parts = remainder.split("/");
  return parts[0]?.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? null;
}

function osvSeverity(vulnerability: OsvVulnerability): AuditSeverity {
  const declared = vulnerability.database_specific?.severity;
  if (typeof declared === "string") return normalizedSeverity(declared);
  const cvss = vulnerability.severity
    ?.map((entry) => entry.score)
    .find((score): score is string => typeof score === "string");
  const baseScore = cvss?.match(/(?:^|\/)AV:[^/]+.*?/) ? null : Number(cvss);
  if (baseScore !== null && Number.isFinite(baseScore)) {
    if (baseScore >= 9) return "critical";
    if (baseScore >= 7) return "high";
    if (baseScore >= 4) return "moderate";
    return "low";
  }
  // Missing severity is treated conservatively so an incomplete advisory
  // cannot silently pass the release gate.
  return "high";
}

function highestSeverity(values: AuditSeverity[]): AuditSeverity {
  const order: AuditSeverity[] = ["critical", "high", "moderate", "low", "info"];
  return order.find((severity) => values.includes(severity)) ?? "high";
}

async function fetchOsvJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(OSV_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OSV request failed with HTTP ${response.status}.`);
  return await response.json() as T;
}

async function readAuditReport(lockfile: NpmLockfile): Promise<NpmAuditReport> {
  const queryNodes = new Map<string, { query: OsvQuery; nodes: string[] }>();
  for (const [node, value] of Object.entries(lockfile.packages ?? {})) {
    const name = lockPackageName(node, value);
    if (!name || !value.version) continue;
    const key = `${name}\0${value.version}`;
    const existing = queryNodes.get(key);
    if (existing) existing.nodes.push(node);
    else {
      queryNodes.set(key, {
        query: { package: { ecosystem: "npm", name }, version: value.version },
        nodes: [node],
      });
    }
  }

  const entries = [...queryNodes.values()];
  const matches: Array<{ packageName: string; nodes: string[]; advisoryId: string }> = [];
  for (let start = 0; start < entries.length; start += OSV_QUERY_BATCH_SIZE) {
    const batch = entries.slice(start, start + OSV_QUERY_BATCH_SIZE);
    const response = await fetchOsvJson<{ results?: OsvBatchResult[] }>(
      "https://api.osv.dev/v1/querybatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: batch.map((entry) => entry.query) }),
      },
    );
    if (!Array.isArray(response.results) || response.results.length !== batch.length) {
      throw new Error("OSV batch response did not match the dependency query.");
    }
    response.results.forEach((result, index) => {
      if (result.next_page_token) {
        throw new Error("OSV returned a paginated result that the release audit cannot safely omit.");
      }
      for (const vulnerability of result.vulns ?? []) {
        if (typeof vulnerability.id !== "string" || !vulnerability.id) {
          throw new Error("OSV returned an invalid vulnerability identifier.");
        }
        const entry = batch[index];
        if (!entry) throw new Error("OSV batch response index was invalid.");
        matches.push({
          packageName: entry.query.package.name,
          nodes: entry.nodes,
          advisoryId: vulnerability.id,
        });
      }
    });
  }

  const detailById = new Map<string, OsvVulnerability>();
  const advisoryIds = [...new Set(matches.map((match) => match.advisoryId))];
  for (let start = 0; start < advisoryIds.length; start += 20) {
    const batch = advisoryIds.slice(start, start + 20);
    const details = await Promise.all(
      batch.map((id) =>
        fetchOsvJson<OsvVulnerability>(
          `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
        ),
      ),
    );
    details.forEach((detail, index) => detailById.set(batch[index]!, detail));
  }

  const vulnerabilities: Record<string, NpmAuditVulnerability> = {};
  for (const match of matches) {
    const detail = detailById.get(match.advisoryId);
    if (!detail) throw new Error(`OSV detail was missing for ${match.advisoryId}.`);
    const aliases = Array.isArray(detail.aliases)
      ? detail.aliases.filter((value): value is string => typeof value === "string")
      : [];
    const id = [match.advisoryId, ...aliases].find((value) => /^GHSA-/iu.test(value))
      ?? match.advisoryId;
    const severity = osvSeverity(detail);
    const advisory: NpmAuditAdvisory = {
      source: id,
      name: match.packageName,
      dependency: match.packageName,
      title: typeof detail.summary === "string" ? detail.summary : id,
      url: `https://osv.dev/vulnerability/${encodeURIComponent(match.advisoryId)}`,
      severity,
    };
    const current = vulnerabilities[match.packageName];
    if (!current) {
      vulnerabilities[match.packageName] = {
        name: match.packageName,
        severity,
        via: [advisory],
        nodes: [...match.nodes],
      };
      continue;
    }
    const alreadyRecorded = current.via?.some(
      (value) => typeof value === "object" && value.source === id,
    );
    if (!alreadyRecorded) current.via = [...(current.via ?? []), advisory];
    current.nodes = [...new Set([...(current.nodes ?? []), ...match.nodes])];
    current.severity = highestSeverity([normalizedSeverity(current.severity), severity]);
  }
  return { auditReportVersion: 2, vulnerabilities };
}

async function run(): Promise<number> {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDirectory, "..");
  const manifest = readJsonFile<PackageManifest>(path.join(repositoryRoot, "package.json"));
  const lockfile = readJsonFile<NpmLockfile>(path.join(repositoryRoot, "package-lock.json"));
  const evaluation = evaluateRuntimeAudit(await readAuditReport(lockfile), { manifest, lockfile });

  console.log(formatRuntimeAuditResult(evaluation));
  return evaluation.passed ? 0 : 1;
}

const invokedScript = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedScript === fileURLToPath(import.meta.url)) {
  run().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
