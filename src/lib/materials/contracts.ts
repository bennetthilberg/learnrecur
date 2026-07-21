import { z } from "zod";

export const MATERIAL_LOCATOR_VERSION = 1 as const;
export const MATERIAL_SCOPE_PLAN_VERSION = 1 as const;
export const MAX_MATERIAL_PDF_BYTES = 100 * 1024 * 1024;
export const MAX_MATERIAL_PDF_PAGES = 1_000;
export const MAX_WEBSITE_REVISION_BYTES = 50 * 1024 * 1024;
export const MAX_WEBSITE_REVISION_PAGES = 250;
export const MAX_SKILLS_PER_BATCH = 10;

const identifierSchema = z.string().trim().min(1).max(200);
const uniqueIdentifiersSchema = (maximum: number) =>
  z
    .array(identifierSchema)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, {
      message: "Identifiers must be unique.",
    });

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const pdfPageRangeSchema = z
  .object({
    start: z.number().int().min(1).max(MAX_MATERIAL_PDF_PAGES),
    end: z.number().int().min(1).max(MAX_MATERIAL_PDF_PAGES),
  })
  .refine((range) => range.end >= range.start, {
    message: "A page range cannot end before it starts.",
    path: ["end"],
  });

const pdfSourceLocatorSchema = z
  .object({
    kind: z.literal("pdf"),
    pageRanges: z.array(pdfPageRangeSchema).min(1).max(32),
  })
  .superRefine((source, context) => {
    for (let index = 1; index < source.pageRanges.length; index += 1) {
      const previous = source.pageRanges[index - 1];
      const current = source.pageRanges[index];

      if (current.start <= previous.end) {
        context.addIssue({
          code: "custom",
          message: "PDF page ranges must be ordered and cannot overlap.",
          path: ["pageRanges", index],
        });
      }
    }
  });

export const httpsUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_048)
  .refine(isHttpsUrl, {
    message: "Only HTTPS URLs are supported.",
  });

const webSourceLocatorSchema = z.object({
  kind: z.literal("web"),
  anchors: z
    .array(
      z.object({
        url: httpsUrlSchema,
        heading: z.string().trim().min(1).max(500).optional(),
        anchor: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(32),
});

export const skillSourceLocatorSchema = z
  .object({
    version: z.literal(MATERIAL_LOCATOR_VERSION),
    materialRevisionId: identifierSchema,
    materialSectionIds: uniqueIdentifiersSchema(24),
    evidenceChunkIds: uniqueIdentifiersSchema(80),
    source: z.discriminatedUnion("kind", [pdfSourceLocatorSchema, webSourceLocatorSchema]),
  })
  .superRefine((locator, context) => {
    if (locator.source.kind === "web") {
      const keys = locator.source.anchors.map(
        (anchor) => `${anchor.url}\u0000${anchor.heading ?? ""}\u0000${anchor.anchor ?? ""}`,
      );

      if (new Set(keys).size !== keys.length) {
        context.addIssue({
          code: "custom",
          message: "Web evidence anchors must be unique.",
          path: ["source", "anchors"],
        });
      }
    }
  });

export type SkillSourceLocator = z.infer<typeof skillSourceLocatorSchema>;

export const materialScopePlanItemSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(160),
    objective: z.string().trim().min(1).max(1_000),
    materialSectionIds: uniqueIdentifiersSchema(24),
    evidenceChunkIds: uniqueIdentifiersSchema(80),
    locator: skillSourceLocatorSchema,
    overlapSkillId: identifierSchema.optional(),
    overlapWarning: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((item, context) => {
    if (
      !sameStringSet(item.materialSectionIds, item.locator.materialSectionIds) ||
      !sameStringSet(item.evidenceChunkIds, item.locator.evidenceChunkIds)
    ) {
      context.addIssue({
        code: "custom",
        message: "Plan evidence must match the versioned locator.",
        path: ["locator"],
      });
    }
  });

const materialScopeResolutionBaseSchema = z.object({
  version: z.literal(MATERIAL_SCOPE_PLAN_VERSION),
  materialRevisionId: identifierSchema,
  instruction: z.string().trim().min(3).max(4_000),
  resolutionStatus: z.enum(["resolved", "ambiguous"]),
  resolvedScopeLabel: z.string().trim().min(1).max(1_000),
  warnings: z.array(z.string().trim().min(1).max(500)).max(20),
  clarification: z.string().trim().min(1).max(1_000).optional(),
  items: z.array(materialScopePlanItemSchema).max(MAX_SKILLS_PER_BATCH),
});

function validateScopePlanItems(
  plan: z.infer<typeof materialScopeResolutionBaseSchema>,
  context: z.RefinementCtx,
) {
  const keys = plan.items.map((item) => item.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({
      code: "custom",
      message: "Each proposed skill must have a unique key.",
      path: ["items"],
    });
  }

  for (const [index, item] of plan.items.entries()) {
    if (item.locator.materialRevisionId !== plan.materialRevisionId) {
      context.addIssue({
        code: "custom",
        message: "Every skill must cite the planned material revision.",
        path: ["items", index, "locator", "materialRevisionId"],
      });
    }
  }
}

export const materialScopeResolutionSchema = materialScopeResolutionBaseSchema.superRefine(
  (plan, context) => {
    if (plan.resolutionStatus === "ambiguous" && !plan.clarification) {
      context.addIssue({
        code: "custom",
        message: "Ambiguous scope requires a clarification message.",
        path: ["clarification"],
      });
    }

    validateScopePlanItems(plan, context);
  },
);

export const materialScopePlanSchema = materialScopeResolutionBaseSchema.superRefine(
  (plan, context) => {
    if (plan.resolutionStatus !== "resolved") {
      context.addIssue({
        code: "custom",
        message: "Ambiguous material scope cannot be confirmed.",
        path: ["resolutionStatus"],
      });
    }

    if (plan.items.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A confirmed plan must contain at least one skill.",
        path: ["items"],
      });
    }

    validateScopePlanItems(plan, context);
  },
);

export type MaterialScopeResolution = z.infer<typeof materialScopeResolutionSchema>;
export type MaterialScopePlan = z.infer<typeof materialScopePlanSchema>;

export const prepareMaterialPdfInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  collectionId: identifierSchema.nullable().optional(),
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.literal("application/pdf"),
  byteSize: z.coerce.number().int().min(1).max(MAX_MATERIAL_PDF_BYTES),
});

export const discoverWebsiteMaterialInputSchema = z.object({
  url: httpsUrlSchema,
});

export const confirmWebsiteImportInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  collectionId: identifierSchema.nullable().optional(),
  sourceUrl: httpsUrlSchema,
  selectedUrls: z.array(httpsUrlSchema).min(1).max(MAX_WEBSITE_REVISION_PAGES),
});

export const planMaterialSkillsInputSchema = z.object({
  materialId: identifierSchema,
  materialRevisionId: identifierSchema,
  instruction: z.string().trim().min(3).max(4_000),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export const confirmMaterialPlanInputSchema = z.object({
  batchId: identifierSchema,
  plan: materialScopePlanSchema,
});

export const materialProgressInputSchema = z.object({
  materialId: identifierSchema,
});

export const batchProgressInputSchema = z.object({
  batchId: identifierSchema,
});

export const batchItemMutationInputSchema = z.object({
  batchId: identifierSchema,
  itemId: identifierSchema,
});

export const activateBatchInputSchema = z.object({
  batchId: identifierSchema,
  itemIds: uniqueIdentifiersSchema(MAX_SKILLS_PER_BATCH),
});

export const refreshMaterialInputSchema = z.object({
  materialId: identifierSchema,
});

export const deleteMaterialInputSchema = z.object({
  materialId: identifierSchema,
  confirmationTitle: z.string().trim().min(1).max(200),
});

function sameStringSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value) => right.includes(value));
}
