/**
 * Shared import limits used by web mutations and background workers.
 *
 * Keep this module free of server-only imports so request schemas and worker
 * code cannot drift apart when they enforce the same boundary.
 */
export const DEFAULT_ACTIVE_SKILL_LIMIT = 250;
export const DEFAULT_SKILL_ACTIVATIONS_PER_UTC_DAY = 250;
export const MAX_IMPORT_BATCH_ITEMS = 25;
export const MAX_PENDING_IMPORT_ITEMS = 50;
export const MAX_INLINE_OPERATION_ITEMS_PER_DELIVERY = 5;
export const REFILL_DEFERRED_CHECKPOINT = "deferred-quota";

export type ImportLimitConfig = {
  activeSkillLimit: number;
  skillActivationsPerUtcDay: number;
};

export class ImportLimitConfigurationError extends Error {
  readonly code = "INVALID_USAGE_LIMIT_CONFIGURATION";

  constructor(variableName: string) {
    super(`${variableName} must be a positive safe integer.`);
    this.name = "ImportLimitConfigurationError";
  }
}

export function resolveImportLimitConfig(
  env: Record<string, string | undefined> = process.env,
): ImportLimitConfig {
  return {
    activeSkillLimit: readPositiveSafeInteger(
      env.LEARNRECUR_ACTIVE_SKILL_LIMIT,
      DEFAULT_ACTIVE_SKILL_LIMIT,
      "LEARNRECUR_ACTIVE_SKILL_LIMIT",
    ),
    skillActivationsPerUtcDay: readPositiveSafeInteger(
      env.LEARNRECUR_SKILL_ACTIVATIONS_PER_UTC_DAY,
      DEFAULT_SKILL_ACTIVATIONS_PER_UTC_DAY,
      "LEARNRECUR_SKILL_ACTIVATIONS_PER_UTC_DAY",
    ),
  };
}

function readPositiveSafeInteger(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ImportLimitConfigurationError(variableName);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ImportLimitConfigurationError(variableName);
  }
  return parsed;
}
