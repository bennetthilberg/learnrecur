"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import {
  archiveCollection,
  createCollection,
  restoreCollection,
  updateCollection,
} from "@/lib/collections";
import { ensureDatabaseUser } from "@/lib/users";

export type CollectionFormActionState = {
  status: "idle" | "error" | "saved";
  message: string | null;
  fieldErrors?: Record<string, string[]>;
};

type CollectionActionUserResult =
  | {
      status: "ready";
      userId: string;
    }
  | {
      status: "error";
      message: string;
    };

export async function createCollectionAction(
  _previousState: CollectionFormActionState,
  formData: FormData,
): Promise<CollectionFormActionState> {
  const user = await requireCollectionActionUser();

  if (user.status === "error") {
    return user;
  }

  const result = await createCollection({
    userId: user.userId,
    input: formDataToCollectionInput(formData),
  });

  if (result.status === "created") {
    revalidateCollectionPaths();

    return {
      status: "saved",
      message: "Collection created.",
    };
  }

  return {
    status: "error",
    message: result.message,
    fieldErrors: result.fieldErrors,
  };
}

export async function updateCollectionAction(
  _previousState: CollectionFormActionState,
  formData: FormData,
): Promise<CollectionFormActionState> {
  const user = await requireCollectionActionUser();

  if (user.status === "error") {
    return user;
  }

  const collectionId = getOptionalFormString(formData, "collectionId");

  if (!collectionId) {
    return {
      status: "error",
      message: "No collection was selected.",
    };
  }

  const result = await updateCollection({
    userId: user.userId,
    collectionId,
    input: formDataToCollectionInput(formData),
  });

  if (result.status === "updated") {
    revalidateCollectionPaths();

    return {
      status: "saved",
      message: "Collection updated.",
    };
  }

  if (result.status === "invalid") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function archiveCollectionAction(
  _previousState: CollectionFormActionState,
  formData: FormData,
): Promise<CollectionFormActionState> {
  const user = await requireCollectionActionUser();

  if (user.status === "error") {
    return user;
  }

  const collectionId = getOptionalFormString(formData, "collectionId");

  if (!collectionId) {
    return {
      status: "error",
      message: "No collection was selected.",
    };
  }

  const result = await archiveCollection({
    userId: user.userId,
    collectionId,
  });

  if (result.status === "updated") {
    revalidateCollectionPaths();

    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status: "error",
    message: result.message,
    fieldErrors: result.status === "invalid" ? result.fieldErrors : undefined,
  };
}

export async function restoreCollectionAction(
  _previousState: CollectionFormActionState,
  formData: FormData,
): Promise<CollectionFormActionState> {
  const user = await requireCollectionActionUser();

  if (user.status === "error") {
    return user;
  }

  const collectionId = getOptionalFormString(formData, "collectionId");

  if (!collectionId) {
    return {
      status: "error",
      message: "No collection was selected.",
    };
  }

  const result = await restoreCollection({
    userId: user.userId,
    collectionId,
  });

  if (result.status === "updated") {
    revalidateCollectionPaths();

    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status: "error",
    message: result.message,
    fieldErrors: result.status === "invalid" ? result.fieldErrors : undefined,
  };
}

async function requireCollectionActionUser(): Promise<CollectionActionUserResult> {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    return {
      status: "error",
      message: "Sign in again before changing collections.",
    };
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return {
      status: "error",
      message: databaseUser.message,
    };
  }

  return {
    status: "ready",
    userId,
  };
}

function formDataToCollectionInput(formData: FormData) {
  return {
    name: getOptionalFormString(formData, "name") ?? "",
    description: getOptionalFormString(formData, "description") ?? "",
  };
}

function getOptionalFormString(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function revalidateCollectionPaths() {
  revalidatePath("/collections");
  revalidatePath("/dashboard");
  revalidatePath("/skills");
  revalidatePath("/practice");
}
