import { z } from "zod";

const optionalNonEmptyString = (schema: z.ZodString) =>
  z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }

    return value;
  }, schema.optional());

const postgresUrlSchema = (name: string) =>
  z
    .string()
    .trim()
    .min(1, `${name} is required`)
    .refine((value) => /^postgres(?:ql)?:\/\//.test(value), {
      message: `${name} must be a postgres:// or postgresql:// URL`,
    });

const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema("DATABASE_URL"),
  DIRECT_URL: optionalNonEmptyString(postgresUrlSchema("DIRECT_URL")),
});

const requiredDatabaseEnvSchema = z.object({
  DATABASE_URL: postgresUrlSchema("DATABASE_URL"),
  DIRECT_URL: postgresUrlSchema("DIRECT_URL"),
});

const clerkEnvSchema = z.object({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .trim()
    .min(1, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required")
    .refine((value) => value.startsWith("pk_"), {
      message: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_",
    }),
  CLERK_SECRET_KEY: z
    .string()
    .trim()
    .min(1, "CLERK_SECRET_KEY is required")
    .refine((value) => value.startsWith("sk_"), {
      message: "CLERK_SECRET_KEY must start with sk_",
    }),
  CLERK_WEBHOOK_SECRET: optionalNonEmptyString(z.string().trim()),
});

const productionClerkEnvSchema = clerkEnvSchema.extend({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z
    .string()
    .trim()
    .min(1, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required")
    .refine((value) => value.startsWith("pk_live_"), {
      message: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be a production pk_live_ key",
    }),
  CLERK_SECRET_KEY: z
    .string()
    .trim()
    .min(1, "CLERK_SECRET_KEY is required")
    .refine((value) => value.startsWith("sk_live_"), {
      message: "CLERK_SECRET_KEY must be a production sk_live_ key",
    }),
});

const geminiModelSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  return value;
}, z.string().trim().min(1).default("gemini-3.5-flash"));

const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z
    .string({ error: "GEMINI_API_KEY is required" })
    .trim()
    .min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: geminiModelSchema,
});

const appUrlSchema = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }

  if (value === undefined && process.env.NODE_ENV === "development") {
    return "http://localhost:3000";
  }

  return value;
}, z
  .string({ error: "NEXT_PUBLIC_APP_URL is required" })
  .trim()
  .min(1, "NEXT_PUBLIC_APP_URL is required")
  .url("NEXT_PUBLIC_APP_URL must be a valid URL")
);

const productionAppUrlSchema = appUrlSchema.superRefine((value, context) => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return;
  }

  if (url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "NEXT_PUBLIC_APP_URL must use https:// in production",
    });
  }

  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    context.addIssue({
      code: "custom",
      message: "NEXT_PUBLIC_APP_URL must not point at localhost in production",
    });
  }
});

const resendEnvSchema = z.object({
  RESEND_API_KEY: z
    .string({ error: "RESEND_API_KEY is required" })
    .trim()
    .min(1, "RESEND_API_KEY is required")
    .refine((value) => value.startsWith("re_"), {
      message: "RESEND_API_KEY must start with re_",
    }),
  RESEND_FROM_EMAIL: z
    .string({ error: "RESEND_FROM_EMAIL is required" })
    .trim()
    .min(1, "RESEND_FROM_EMAIL is required")
    .refine(isValidSenderEmail, {
      message: "RESEND_FROM_EMAIL must contain a valid email address",
    }),
  NEXT_PUBLIC_APP_URL: appUrlSchema,
});

const s3EnvSchema = z.object({
  AWS_REGION: z
    .string({ error: "AWS_REGION is required" })
    .trim()
    .min(1, "AWS_REGION is required"),
  S3_BUCKET_NAME: z
    .string({ error: "S3_BUCKET_NAME is required" })
    .trim()
    .min(1, "S3_BUCKET_NAME is required"),
  AWS_ACCESS_KEY_ID: z
    .string({ error: "AWS_ACCESS_KEY_ID is required" })
    .trim()
    .min(1, "AWS_ACCESS_KEY_ID is required"),
  AWS_SECRET_ACCESS_KEY: z
    .string({ error: "AWS_SECRET_ACCESS_KEY is required" })
    .trim()
    .min(1, "AWS_SECRET_ACCESS_KEY is required"),
});

const inngestProductionEnvSchema = z.object({
  INNGEST_APP_ID: z
    .string({ error: "INNGEST_APP_ID is required" })
    .trim()
    .min(1, "INNGEST_APP_ID is required"),
  INNGEST_DEV: optionalNonEmptyString(z.string().trim()),
  INNGEST_EVENT_KEY: z
    .string({ error: "INNGEST_EVENT_KEY is required" })
    .trim()
    .min(1, "INNGEST_EVENT_KEY is required"),
  INNGEST_SIGNING_KEY: z
    .string({ error: "INNGEST_SIGNING_KEY is required" })
    .trim()
    .min(1, "INNGEST_SIGNING_KEY is required"),
});

const falseEnvValues = new Set(["0", "false", "no", "n", "off"]);

const productionEnvSchema = requiredDatabaseEnvSchema
  .merge(productionClerkEnvSchema)
  .merge(geminiEnvSchema)
  .merge(
    resendEnvSchema.extend({
      NEXT_PUBLIC_APP_URL: productionAppUrlSchema,
    }),
  )
  .merge(s3EnvSchema)
  .merge(inngestProductionEnvSchema)
  .superRefine((value, context) => {
    if (value.INNGEST_APP_ID === "learnrecur-dev") {
      context.addIssue({
        code: "custom",
        path: ["INNGEST_APP_ID"],
        message: "INNGEST_APP_ID must not be learnrecur-dev in production",
      });
    }

    if (value.INNGEST_DEV && !falseEnvValues.has(value.INNGEST_DEV.toLowerCase())) {
      context.addIssue({
        code: "custom",
        path: ["INNGEST_DEV"],
        message: "INNGEST_DEV must be absent or false in production",
      });
    }
  });

const activeEnvSchema = databaseEnvSchema.merge(clerkEnvSchema);

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type ClerkEnv = z.infer<typeof clerkEnvSchema>;
export type GeminiEnv = z.infer<typeof geminiEnvSchema>;
export type ResendEnv = z.infer<typeof resendEnvSchema>;
export type S3Env = z.infer<typeof s3EnvSchema>;
export type ProductionEnv = z.infer<typeof productionEnvSchema>;
export type ActiveEnv = z.infer<typeof activeEnvSchema>;

export function getDatabaseEnv(): DatabaseEnv {
  return databaseEnvSchema.parse(process.env);
}

export function getClerkEnv(): ClerkEnv {
  return clerkEnvSchema.parse(process.env);
}

export function getActiveEnv(): ActiveEnv {
  return activeEnvSchema.parse(process.env);
}

export function getGeminiEnv(): GeminiEnv {
  return geminiEnvSchema.parse(process.env);
}

export function getResendEnv(): ResendEnv {
  return resendEnvSchema.parse(process.env);
}

export function getS3Env(): S3Env {
  return s3EnvSchema.parse(process.env);
}

export function getProductionEnv(): ProductionEnv {
  return productionEnvSchema.parse(process.env);
}

export function hasDatabaseEnv(): boolean {
  return databaseEnvSchema.safeParse(process.env).success;
}

export function hasClerkEnv(): boolean {
  return clerkEnvSchema.safeParse(process.env).success;
}

export function hasActiveEnv(): boolean {
  return activeEnvSchema.safeParse(process.env).success;
}

export function hasGeminiEnv(): boolean {
  return geminiEnvSchema.safeParse(process.env).success;
}

export function hasResendEnv(): boolean {
  return resendEnvSchema.safeParse(process.env).success;
}

export function hasS3Env(): boolean {
  return s3EnvSchema.safeParse(process.env).success;
}

export function hasProductionEnv(): boolean {
  return productionEnvSchema.safeParse(process.env).success;
}

export function shouldCheckProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEARNRECUR_STRICT_ENV === "1" || env.VERCEL_ENV === "production";
}

export function formatEnvError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(formatZodIssue).join("; ");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Missing or invalid environment configuration.";
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.join(".");

  if (
    path &&
    issue.code === "invalid_type" &&
    issue.expected === "string" &&
    (issue.input === undefined || issue.input === null)
  ) {
    return `${path} is required`;
  }

  return issue.message;
}

function isValidSenderEmail(value: string): boolean {
  const addressMatch = value.match(/<([^<>]+)>$/);
  const address = addressMatch ? addressMatch[1].trim() : value;
  return z.string().email().safeParse(address).success;
}
