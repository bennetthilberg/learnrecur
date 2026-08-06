import "server-only";

import {
  MaterialPageTextStatus,
  type Prisma,
} from "@/generated/prisma/client";

const READY_MATERIAL_OCR_PAGE_WHERE = {
  textStatus: MaterialPageTextStatus.OCR_READY,
  ocrText: { not: null },
} satisfies Prisma.MaterialPageWhereInput;

const READY_MATERIAL_OCR_PAGE_SELECT = {
  pageNumber: true,
  embeddedText: true,
  ocrText: true,
  textStatus: true,
  contentHash: true,
  tokenEstimate: true,
  metadata: true,
} satisfies Prisma.MaterialPageSelect;

export function readyMaterialOcrPageQuery(input: {
  userId: string;
  materialRevisionId: string;
}) {
  return {
    where: {
      userId: input.userId,
      materialRevisionId: input.materialRevisionId,
      ...READY_MATERIAL_OCR_PAGE_WHERE,
    },
    select: READY_MATERIAL_OCR_PAGE_SELECT,
  } satisfies {
    where: Prisma.MaterialPageWhereInput;
    select: Prisma.MaterialPageSelect;
  };
}
