const safeCodes = new Set([
  "AccessDenied", "AccessDeniedException", "CredentialsProviderError", "ExpiredToken",
  "InvalidClientTokenId", "UnrecognizedClientException", "QueueDoesNotExist",
  "AWS.SimpleQueueService.NonExistentQueue",
  "JOB_QUEUE_ENVIRONMENT_MISMATCH", "JOB_DEPLOYMENT_ENVIRONMENT_MISMATCH",
  "JOB_LOCAL_ENVIRONMENT_REQUIRED", "JOB_RECEIVE_INVALID", "JOB_WORKER_INITIALIZATION_FAILED",
]);

export function getLocalWorkerFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "JOB_LOCAL_FAILED";
  if (error.name === "ZodError") return "JOB_CONFIGURATION_INVALID";
  // Raw SDK and validation errors can contain credentials or private inputs.
  return [error.name, error.message].find((value) => safeCodes.has(value)) ?? "JOB_LOCAL_FAILED";
}
