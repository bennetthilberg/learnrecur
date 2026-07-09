"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { queueMaterialDeletion } from "@/lib/materials/cleanup";
import {
  prepareMaterialPdf,
  queueMaterialPdfIngestion,
  queueWebsiteMaterialImport,
  queueWebsiteMaterialRefresh,
  retryMaterialIngestion,
} from "@/lib/materials/ingestion";
import { discoverBookWebsite, type WebsiteDiscovery } from "@/lib/materials/web";
import { ensureDatabaseUser } from "@/lib/users";

export type MaterialActionError = {
  status: "error";
  message: string;
  fieldErrors?: Record<string, string[]>;
};

export type PrepareMaterialPdfActionResult =
  | {
      status: "prepared";
      materialId: string;
      materialRevisionId: string;
      uploadUrl: string;
      headers: Record<string, string>;
    }
  | MaterialActionError;

export async function prepareMaterialPdfAction(
  formData: FormData,
): Promise<PrepareMaterialPdfActionResult> {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return user;
  }
  const result = await prepareMaterialPdf({
    userId: user.userId,
    now: new Date(),
    input: {
      title: formString(formData, "title"),
      collectionId: optionalFormString(formData, "collectionId"),
      originalName: formString(formData, "originalName"),
      mimeType: formString(formData, "mimeType"),
      byteSize: formString(formData, "byteSize"),
    },
  });
  if (result.status !== "prepared") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }
  return {
    status: "prepared",
    materialId: result.materialId,
    materialRevisionId: result.materialRevisionId,
    uploadUrl: result.uploadUrl,
    headers: result.headers,
  };
}

export async function completeMaterialPdfAction(input: {
  materialRevisionId: string;
}): Promise<{ status: "queued"; materialId: string; redirectTo: string; message: string } | MaterialActionError> {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return user;
  }
  const result = await queueMaterialPdfIngestion({
    userId: user.userId,
    materialRevisionId: input.materialRevisionId,
    now: new Date(),
  });
  if (result.status !== "queued") {
    return { status: "error", message: result.message };
  }
  revalidateMaterialPaths(result.materialId);
  return {
    status: "queued",
    materialId: result.materialId,
    redirectTo: `/skills/materials/${result.materialId}`,
    message: result.message,
  };
}

export async function discoverWebsiteMaterialAction(input: {
  url: string;
}): Promise<{ status: "ready"; discovery: WebsiteDiscovery } | MaterialActionError> {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return user;
  }
  try {
    return {
      status: "ready",
      discovery: await discoverBookWebsite({ url: input.url }),
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not inspect that textbook website.",
    };
  }
}

export async function confirmWebsiteMaterialAction(input: {
  title: string;
  collectionId: string | null;
  sourceUrl: string;
  selectedUrls: string[];
}): Promise<{ status: "queued"; materialId: string; redirectTo: string; message: string } | MaterialActionError> {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return user;
  }
  const result = await queueWebsiteMaterialImport({
    userId: user.userId,
    now: new Date(),
    input,
  });
  if (result.status !== "queued") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.status === "invalid" ? result.fieldErrors : undefined,
    };
  }
  revalidateMaterialPaths(result.materialId);
  return {
    status: "queued",
    materialId: result.materialId,
    redirectTo: `/skills/materials/${result.materialId}`,
    message: result.message,
  };
}

export async function retryMaterialIngestionAction(formData: FormData) {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return;
  }
  const materialId = formString(formData, "materialId");
  const materialRevisionId = formString(formData, "materialRevisionId");
  await retryMaterialIngestion({
    userId: user.userId,
    materialRevisionId,
    now: new Date(),
  });
  revalidateMaterialPaths(materialId);
}

export async function refreshWebsiteMaterialAction(formData: FormData) {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return;
  }
  const materialId = formString(formData, "materialId");
  await queueWebsiteMaterialRefresh({
    userId: user.userId,
    materialId,
    now: new Date(),
  });
  revalidateMaterialPaths(materialId);
}

export async function deleteMaterialAction(formData: FormData) {
  const user = await requireMaterialUser();
  if (user.status === "error") {
    return;
  }
  const materialId = formString(formData, "materialId");
  const result = await queueMaterialDeletion({
    userId: user.userId,
    materialId,
    confirmationTitle: formString(formData, "confirmationTitle"),
    now: new Date(),
  });
  if (result.status === "queued") {
    revalidatePath("/skills/materials");
    redirect("/skills/materials?deleted=1");
  }
  revalidateMaterialPaths(materialId);
}

async function requireMaterialUser(): Promise<
  { status: "ready"; userId: string } | MaterialActionError
> {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  if (!clerkUser) {
    return { status: "error", message: `Clerk returned no user for authenticated user ${userId}.` };
  }
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return { status: "error", message: databaseUser.message };
  }
  return { status: "ready", userId };
}

function revalidateMaterialPaths(materialId: string) {
  revalidatePath("/skills");
  revalidatePath("/skills/materials");
  revalidatePath("/skills/new/multiple");
  revalidatePath(`/skills/materials/${materialId}`);
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function optionalFormString(formData: FormData, key: string) {
  return formString(formData, key) || null;
}
