import { z } from "zod";
import type { WebsiteDiscovery } from "@/lib/materials/web";

const text = z.string().max(20_000);
const httpsUrl = z.string().max(20_000).url().refine((value) => /^https:\/\//i.test(value));
export const materialPdfDraftSchema = z.object({ title: text, collectionId: text, fileName: text });
export const materialWebsiteDraftSchema = z.object({
  url: text, title: text, collectionId: text, selectedUrls: z.array(httpsUrl).max(1000),
  discovery: z.object({
    title: text, sourceUrl: httpsUrl,
    pages: z.array(z.object({ title: text, url: httpsUrl, level: z.number().int().min(1).max(20) })).max(1000),
    preferredPdf: z.object({ title: text, url: httpsUrl }).nullable(), notice: text.optional(),
  }).nullable(),
});
export const emptyMaterialWebsiteDraft = {
  url: "", title: "", collectionId: "", selectedUrls: [] as string[], discovery: null as WebsiteDiscovery | null,
};
