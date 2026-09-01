export {
  DEFAULT_CRITICAL_RECALL_THRESHOLD,
  DEFAULT_MAX_SIMILARITY,
  DEFAULT_MIN_SAMPLE_SIZE,
  EVALUATION_DEFECT_CODES,
  EVALUATION_METRICS,
  EVALUATION_PROVIDERS,
  EVALUATION_PROVIDER_SELECTIONS,
  EVALUATION_SCHEMA_VERSION,
  evaluationFixtureSchema,
  evaluationJobSchema,
  fixtureExpectationSchema,
  parseEvaluationFixtures,
  replayAttemptSchema,
  runtimeMetadataSchema,
} from "./contracts";
export {
  buildReport,
  compareEvaluationReports,
  runEvaluation,
  serializeEvaluationArtifact,
  wilsonInterval,
} from "./runner";
export { scoreEvaluationAttempt, scoreFailureFallback } from "./scoring";
export {
  LIVE_SMOKE_CONTRACT_VERSION,
  runLiveProviderSmoke,
} from "./live-smoke";
export type {
  LiveProviderSmokeResult,
  LiveSmokeProvider,
} from "./live-smoke";
export {
  DEFAULT_CANARY_POLICY,
  canTransitionRelease,
  evaluateCanary,
  fingerprintReleaseTuple,
  isCanarySelected,
} from "./release-control";
export type {
  CanaryDecision,
  CanaryObservation,
  CanaryPolicy,
} from "./release-control";
export type {
  AttemptStatus,
  ConfidenceInterval,
  EvaluationAttempt,
  EvaluationDefectCode,
  EvaluationExecutor,
  EvaluationExecutors,
  EvaluationFixture,
  EvaluationJob,
  EvaluationMetricName,
  EvaluationMode,
  EvaluationProvider,
  EvaluationReport,
  EvaluationRunSummary,
  FixtureExpectation,
  GateResult,
  MetricScore,
  MetricStatus,
  MetricSummary,
  ProviderSelection,
  ProviderSummary,
  ReleaseIdentity,
  ReplayAttempt,
  ReportComparison,
  RunEvaluationOptions,
  RuntimeMetadata,
} from "./contracts";
