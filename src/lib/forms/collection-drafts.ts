import { z } from "zod";

export const collectionDraftSchema = z.object({
  name: z.string().max(80),
  description: z.string().max(500),
});
