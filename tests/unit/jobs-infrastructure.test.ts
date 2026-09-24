import { describe, expect, it } from "vitest";
import { createJobsTemplate } from "../../infra/aws/jobs-template";
import { getJobMessageGroupId, parseJobEnvelope } from "@/lib/jobs/contracts";
import {
  AGENT_SKILL_OPERATION_SOFT_DEADLINE_MS,
  getJobSoftDeadlineMs,
  hasValidJobTiming,
  JOB_LEASE_SECONDS,
  JOB_TIMEOUT_SECONDS,
  SQS_VISIBILITY_TIMEOUT_SECONDS,
} from "@/lib/jobs/timing";
import localTemplate from "../../infra/aws/local-queues-template.json";

describe("AWS deployment contract", () => {
  it("keeps the worker deadline, delivery lease, and visibility windows ordered", () => {
    expect(hasValidJobTiming()).toBe(true);
    expect(getJobSoftDeadlineMs("learnrecur/agent-skill-operation.requested"))
      .toBe(AGENT_SKILL_OPERATION_SOFT_DEADLINE_MS);
    expect(AGENT_SKILL_OPERATION_SOFT_DEADLINE_MS).toBeLessThan(JOB_TIMEOUT_SECONDS * 1_000);
    expect(getJobSoftDeadlineMs("learnrecur/choice-refill.requested")).toBe(6 * 60_000);
  });

  it.each(["Queue", "DeadLetters"])("requires TLS for the local %s", (queue) => {
    expect(Object.values(localTemplate.Resources)).toContainEqual({
      Type: "AWS::SQS::QueuePolicy",
      Properties: {
        Queues: [{ Ref: queue }],
        PolicyDocument: { Version: "2012-10-17", Statement: [{
          Effect: "Deny", Principal: "*", Action: "sqs:*", Resource: { "Fn::GetAtt": [queue, "Arn"] },
          Condition: { Bool: { "aws:SecureTransport": "false" } },
        }] },
      },
    });
  });
  it.each(["staging", "production"] as const)("keeps %s encrypted, bounded, isolated, and initially unscheduled", (environment) => {
    const template = createJobsTemplate(environment);
    expect(template.Parameters.EnableSchedules.Default).toBe("false");
    expect(template.Parameters.ReserveWorkerConcurrency.Default).toBe("false");
    expect(template.Conditions.WorkerConcurrencyReserved).toEqual({ "Fn::Equals": [{ Ref: "ReserveWorkerConcurrency" }, "true"] });
    expect(template.Resources.Queue.Properties).toMatchObject({
      FifoQueue: true, ContentBasedDeduplication: true, SqsManagedSseEnabled: true,
      QueueName: `learnrecur-${environment}-jobs.fifo`, VisibilityTimeout: SQS_VISIBILITY_TIMEOUT_SECONDS,
      RedrivePolicy: { maxReceiveCount: 6 },
    });
    expect(template.Resources.Worker.Properties).toMatchObject({
      Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: JOB_TIMEOUT_SECONDS,
      ReservedConcurrentExecutions: { "Fn::If": ["WorkerConcurrencyReserved", { Ref: "MaximumConcurrency" }, { Ref: "AWS::NoValue" }] }, RecursiveLoop: "Allow",
    });
    expect(SQS_VISIBILITY_TIMEOUT_SECONDS).toBeGreaterThan(JOB_TIMEOUT_SECONDS);
    expect(JOB_LEASE_SECONDS).toBeGreaterThan(JOB_TIMEOUT_SECONDS);
    expect(template.Resources.Worker.Properties).not.toHaveProperty("VpcConfig");
    expect(template.Resources.EventSource.Properties).toMatchObject({ BatchSize: 1, FunctionResponseTypes: ["ReportBatchItemFailures"], ScalingConfig: { MaximumConcurrency: { Ref: "MaximumConcurrency" } } });
    expect(template.Resources.EventSource.Properties).not.toHaveProperty("ProvisionedPollerConfig");
    expect(template.Resources.PublisherPolicy.Properties.PolicyDocument).toEqual({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["sqs:SendMessage", "sqs:GetQueueAttributes"], Resource: { "Fn::GetAtt": ["Queue", "Arn"] } }] });
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
    expect(template.Resources.AlertPolicy.Properties.PolicyDocument).toMatchObject({ Statement: [{
      Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish",
      Condition: { StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } } },
    }] });
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

  it("keeps worker self-publication and Lambda concurrency explicitly bounded", () => {
    const resources = createJobsTemplate("production").Resources;
    const workerRole = resources.WorkerRole.Properties.Policies as {
      PolicyDocument: { Statement: { Action: string[]; Resource: unknown }[] };
    }[];
    const queueSendPermissions = workerRole[0].PolicyDocument.Statement.filter((statement) =>
      JSON.stringify(statement.Resource).includes('"Queue"'),
    );
    expect(queueSendPermissions).toContainEqual(expect.objectContaining({
      Action: expect.arrayContaining(["sqs:SendMessage"]),
      Resource: { "Fn::GetAtt": ["Queue", "Arn"] },
    }));
  });

  it("keeps staging and production within ten standard alarms", () => {
    const alarms = ["staging", "production"].flatMap((environment) => Object.values(createJobsTemplate(environment as "staging" | "production").Resources).filter((resource) => resource.Type === "AWS::CloudWatch::Alarm"));
    expect(alarms).toHaveLength(10);
  });
});
