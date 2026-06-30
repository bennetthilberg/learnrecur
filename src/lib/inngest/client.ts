import "server-only";

import { Inngest } from "inngest";

export const DEFAULT_INNGEST_APP_ID = "learnrecur-dev";

export type InngestEnvStatus =
  | {
      status: "ready";
      appId: string;
      isDev: boolean;
    }
  | {
      status: "missing-env";
      message: string;
    };

export function getInngestAppId(env: NodeJS.ProcessEnv = process.env): string {
  return env.INNGEST_APP_ID?.trim() || DEFAULT_INNGEST_APP_ID;
}

export function isInngestDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") {
    return false;
  }

  const rawDevMode = env.INNGEST_DEV?.trim().toLowerCase();

  if (rawDevMode) {
    if (["1", "true", "yes", "y", "on"].includes(rawDevMode)) {
      return true;
    }

    if (["0", "false", "no", "n", "off"].includes(rawDevMode)) {
      return false;
    }

    try {
      new URL(rawDevMode);
      return true;
    } catch {
      // Unknown strings fall back to NODE_ENV so values like "false" do not
      // accidentally enable dev mode.
    }
  }

  return true;
}

export function getInngestEnvStatus(env: NodeJS.ProcessEnv = process.env): InngestEnvStatus {
  const appId = getInngestAppId(env);
  const isDev = isInngestDevMode(env);

  if (isDev) {
    return {
      status: "ready",
      appId,
      isDev,
    };
  }

  const missing: string[] = [];

  if (!env.INNGEST_EVENT_KEY?.trim()) {
    missing.push("INNGEST_EVENT_KEY");
  }

  if (!env.INNGEST_SIGNING_KEY?.trim()) {
    missing.push("INNGEST_SIGNING_KEY");
  }

  if (missing.length > 0) {
    return {
      status: "missing-env",
      message: `Missing Inngest environment configuration: ${missing.join(", ")}.`,
    };
  }

  return {
    status: "ready",
    appId,
    isDev,
  };
}

export function getInngestClientEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  if (isInngestDevMode(env)) {
    return env;
  }

  return {
    ...env,
    INNGEST_DEV: undefined,
  };
}

export const inngest = new Inngest({
  id: getInngestAppId(),
  eventKey: process.env.INNGEST_EVENT_KEY?.trim() || undefined,
  signingKey: process.env.INNGEST_SIGNING_KEY?.trim() || undefined,
  isDev: isInngestDevMode(),
}).setEnvVars(getInngestClientEnv());
