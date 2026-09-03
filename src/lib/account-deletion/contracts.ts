export const ACCOUNT_DELETION_CONFIRMATION = "DELETE MY ACCOUNT" as const;
export const ACCOUNT_DELETION_MANIFEST_VERSION = 1 as const;

export type AccountDeletionStorageObject = {
  bucket: string | null;
  key: string;
};

export type AccountDeletionAgentConnection = {
  connectionId: string;
};

export type AccountDeletionManifest = {
  version: typeof ACCOUNT_DELETION_MANIFEST_VERSION;
  storageObjects: AccountDeletionStorageObject[];
  agentConnections: AccountDeletionAgentConnection[];
};

export type AccountDeletionUiStatus =
  | "none"
  | "PENDING"
  | "RUNNING"
  | "FAILED"
  | "COMPLETE";

export type AccountDeletionUiSnapshot = {
  status: AccountDeletionUiStatus;
  phase: string | null;
  lastErrorCode: string | null;
};
