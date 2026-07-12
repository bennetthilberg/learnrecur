"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { autoRepairMaterialDraftItemsAction } from "./actions";

export function BatchAutomaticRecovery({
  batchId,
  itemIds,
}: {
  batchId: string;
  itemIds: string[];
}) {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (started.current || itemIds.length === 0) {
      return;
    }
    started.current = true;
    void autoRepairMaterialDraftItemsAction({ batchId, itemIds }).then(
      () => router.refresh(),
      () => router.refresh(),
    );
  }, [batchId, itemIds, router]);

  return null;
}
