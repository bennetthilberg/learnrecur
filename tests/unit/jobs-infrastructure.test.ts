import { describe, expect, it } from "vitest";
import { createJobsTemplate } from "../../infra/aws/jobs-template";
import { getJobMessageGroupId, parseJobEnvelope } from "@/lib/jobs/contracts";

describe("AWS deployment contract", () => {
  it.each(["staging", "production"] as const)("keeps %s encrypted, bounded, isolated, and initially unscheduled", (environment) => {
    const template = createJobsTemplate(environment);
    expect(template.Parameters.EnableSchedules.Default).toBe("false");
    expect(template.Resources.Queue.Properties).toMatchObject({
      FifoQueue: true, ContentBasedDeduplication: true, SqsManagedSseEnabled: true,
      QueueName: `learnrecur-${environment}-jobs.fifo`, VisibilityTimeout: 3600,
      RedrivePolicy: { maxReceiveCount: 6 },
    });
    expect(template.Resources.Worker.Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: 600 });
    expect(template.Resources.Worker.Properties).not.toHaveProperty("VpcConfig");
    expect(template.Resources.EventSource.Properties).toMatchObject({ BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"] });
    expect(template.Resources.EventSource.Properties).not.toHaveProperty("ProvisionedPollerConfig");
    expect(template.Resources.SchedulerDeadLetters.Properties).not.toHaveProperty("FifoQueue");
    expect(template.Resources.DeadLetters.Properties).toMatchObject({ FifoQueue: true, MessageRetentionPeriod: 1209600 });
    const policies = Object.values(template.Resources).filter((resource) => resource.Type === "AWS::SQS::QueuePolicy");
    expect(policies).toHaveLength(3);
    for (const policy of policies) {
      const document = policy.Properties.PolicyDocument as { Statement: { Resource: unknown; Condition: unknown }[] };
      expect(Array.isArray(document.Statement[0].Resource)).toBe(false);
      expect(document.Statement[0].Condition).toEqual({ Bool: { "aws:SecureTransport": "false" } });
    }
    const trust = template.Resources.WorkerRole.Properties.AssumeRolePolicyDocument as { Statement: { Principal: unknown; Condition?: unknown }[] };
    expect(trust.Statement[0]).toEqual({ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" });
  });

  it.each(["staging", "production"] as const)("creates valid, deduplicated %s schedule messages in the worker's FIFO groups", (environment) => {
    const schedules = Object.values(createJobsTemplate(environment).Resources).filter((resource) => resource.Type === "AWS::Scheduler::Schedule");
    expect(schedules).toHaveLength(3);
    for (const schedule of schedules) {
      const target = schedule.Properties.Target as { Input: string; SqsParameters: { MessageGroupId: string } };
      expect(target.Input).not.toContain("execution-id");
      const body = target.Input.replaceAll("<aws.scheduler.scheduled-time>", "2026-09-05T03:00:00Z");
      const job = parseJobEnvelope(body, environment);
      expect(target.SqsParameters.MessageGroupId).toBe(getJobMessageGroupId(job));
    }
  });

  it("includes queue age, dead letters, worker failures, and all three cron silence alarms", () => {
    const alarms = Object.values(createJobsTemplate("production").Resources).filter((resource) => resource.Type === "AWS::CloudWatch::Alarm");
    expect(alarms).toHaveLength(7);
    expect(alarms.every((alarm) => Array.isArray(alarm.Properties.AlarmActions) && alarm.Properties.AlarmActions.length > 0)).toBe(true);
  });

  it("keeps staging and production within ten standard alarms", () => {
    const alarms = ["staging", "production"].flatMap((environment) => Object.values(createJobsTemplate(environment as "staging" | "production").Resources).filter((resource) => resource.Type === "AWS::CloudWatch::Alarm"));
    expect(alarms).toHaveLength(10);
  });
});
