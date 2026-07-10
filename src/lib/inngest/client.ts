import "server-only";

import { Inngest } from "inngest";

export const DEFAULT_INNGEST_APP_ID = "learnrecur-dev";
export const DEFAULT_LOCAL_INNGEST_SERVE_ORIGIN = "http://localhost:3000";

type InngestConfigEnv = Record<string, string | undefined>;

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

export function getInngestAppId(env: InngestConfigEnv = process.env): string {
  return env.INNGEST_APP_ID?.trim() || DEFAULT_INNGEST_APP_ID;
}

export function isInngestDevMode(env: InngestConfigEnv = process.env): boolean {
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

export function getInngestEnvStatus(env: InngestConfigEnv = process.env): InngestEnvStatus {
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
  env: InngestConfigEnv = process.env,
): Record<string, string | undefined> {
  if (isInngestDevMode(env)) {
    return env;
  }

  return {
    ...env,
    INNGEST_DEV: undefined,
  };
}

export function getInngestServeOrigin(env: InngestConfigEnv = process.env): string | undefined {
  if (!isInngestDevMode(env)) {
    return undefined;
  }

  const appUrl = env.NEXT_PUBLIC_APP_URL?.trim();

  if (appUrl) {
    try {
      const url = new URL(appUrl);
      const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

      if (isLoopback && ["http:", "https:"].includes(url.protocol)) {
        return url.origin;
      }
    } catch {
      // Fall back to the standard local origin when the app URL is malformed.
    }
  }

  return DEFAULT_LOCAL_INNGEST_SERVE_ORIGIN;
}

export function createLearnRecurInngestClient(env: InngestConfigEnv = process.env): Inngest {
  const client = new Inngest({
    id: getInngestAppId(env),
    eventKey: env.INNGEST_EVENT_KEY?.trim() || undefined,
    signingKey: env.INNGEST_SIGNING_KEY?.trim() || undefined,
    isDev: isInngestDevMode(env),
  });
  const setEnvVars = client.setEnvVars.bind(client);

  client.setEnvVars = (nextEnv: InngestConfigEnv = process.env) =>
    setEnvVars(getInngestClientEnv(nextEnv));

  return client.setEnvVars(env);
}

export const inngest = createLearnRecurInngestClient();
