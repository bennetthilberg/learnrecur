import { z } from "zod";

export const guidanceDraftSchema = z.object({
  rules: z.string().max(100_000), examples: z.string().max(100_000), constraints: z.string().max(100_000),
});
