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

const activeEnvSchema = databaseEnvSchema.merge(clerkEnvSchema);

export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;
export type ClerkEnv = z.infer<typeof clerkEnvSchema>;
export type GeminiEnv = z.infer<typeof geminiEnvSchema>;
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

export function formatEnvError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join("; ");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Missing or invalid environment configuration.";
}
