import { JOB_DEFINITIONS, buildJobEnvelope, getJobMessageGroupId } from "../../src/lib/jobs/contracts";
import analysis from "./iam-actions.generated.json";

const ref = (name: string) => ({ Ref: name });
const arn = (name: string) => ({ "Fn::GetAtt": [name, "Arn"] });
const sub = (value: string) => ({ "Fn::Sub": value });
type Resource = { Type: string; Properties: Record<string, unknown>; Condition?: string; DependsOn?: string | string[]; DeletionPolicy?: string; UpdateReplacePolicy?: string };

// Autopilot includes conditional SDK capabilities (ACLs, object versions,
// governance bypass, and customer KMS encryption). Keep only the operations
// this deployment enables, and bind them to its named resources.
function actions(...selected: string[]) {
  for (const action of selected) if (!analysis.actions.includes(action)) throw new Error(`IAM analysis is missing ${action}`);
  return selected;
}

export function createJobsTemplate(environment: "staging" | "production") {
  const name = (suffix: string) => `learnrecur-${environment}-${suffix}`;
  const parameterArn = 'arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/learnrecur/' + environment + '/jobs';
  const resources: Record<string, Resource> = {
    DeadLetters: {
      Type: "AWS::SQS::Queue", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: { QueueName: name("jobs-dlq.fifo"), FifoQueue: true, ContentBasedDeduplication: true, SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 },
    },
    SchedulerDeadLetters: {
      Type: "AWS::SQS::Queue", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: { QueueName: name("scheduler-dlq"), SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 },
    },
    Queue: {
      Type: "AWS::SQS::Queue", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: {
        QueueName: name("jobs.fifo"), FifoQueue: true, ContentBasedDeduplication: true,
        SqsManagedSseEnabled: true, MaximumMessageSize: 65536, MessageRetentionPeriod: 345600,
        VisibilityTimeout: 3600, ReceiveMessageWaitTimeSeconds: 20,
        RedrivePolicy: { deadLetterTargetArn: arn("DeadLetters"), maxReceiveCount: 6 },
      },
    },
    WorkerLogGroup: {
      Type: "AWS::Logs::LogGroup", DeletionPolicy: "Retain", UpdateReplacePolicy: "Retain",
      Properties: { LogGroupName: `/aws/lambda/${name("jobs-worker")}`, RetentionInDays: 14 },
    },
    WorkerRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        RoleName: name("jobs-worker"),
        // Lambda's execution-role assumption does not supply SourceArn or
        // SourceAccount here. Strict conditions prevent its SQS mapping from
        // assuming the role. Restrict iam:PassRole on deployment identities.
        AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] },
        Policies: [{ PolicyName: "worker", PolicyDocument: { Version: "2012-10-17", Statement: [
          { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: arn("WorkerLogGroup") },
          { Effect: "Allow", Action: actions("sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes", "sqs:SendMessage"), Resource: arn("Queue") },
          { Effect: "Allow", Action: actions("sqs:SendMessage"), Resource: arn("DeadLetters") },
          { Effect: "Allow", Action: actions("ssm:GetParametersByPath"), Resource: [sub(parameterArn), sub(`${parameterArn}/*`)] },
          { Effect: "Allow", Action: actions("kms:Decrypt"), Resource: sub("arn:${AWS::Partition}:kms:${AWS::Region}:${AWS::AccountId}:key/*"), Condition: { StringEquals: { "kms:ViaService": sub("ssm.${AWS::Region}.amazonaws.com") }, StringLike: { "kms:EncryptionContext:PARAMETER_ARN": sub(`${parameterArn}/*`) } } },
          { Effect: "Allow", Action: actions("s3:GetObject", "s3:PutObject", "s3:DeleteObject"), Resource: sub("arn:${AWS::Partition}:s3:::${SourceBucketName}/source-uploads/*") },
          { Effect: "Allow", Action: actions("s3:ListBucket"), Resource: sub("arn:${AWS::Partition}:s3:::${SourceBucketName}"), Condition: { StringLike: { "s3:prefix": ["source-uploads/*", "__learnrecur_readiness_probe__/*"] } } },
        ] } }],
      },
    },
    Worker: {
      Type: "AWS::Lambda::Function", DependsOn: "WorkerLogGroup",
      Properties: {
        FunctionName: name("jobs-worker"), Runtime: "nodejs24.x", Architectures: ["arm64"],
        Handler: "index.handler", MemorySize: 1024, Timeout: 600,
        Role: arn("WorkerRole"), Code: { S3Bucket: ref("CodeBucket"), S3Key: ref("CodeKey") },
        Environment: { Variables: { NODE_ENV: "production", LEARNRECUR_DEPLOYMENT_TIER: environment, JOBS_ENVIRONMENT: environment, JOBS_QUEUE_URL: ref("Queue"), JOBS_CONFIG_REVISION: ref("ConfigurationRevision") } },
      },
    },
    EventSource: {
      Type: "AWS::Lambda::EventSourceMapping",
      Properties: { EventSourceArn: arn("Queue"), FunctionName: ref("Worker"), BatchSize: 1, Enabled: true, FunctionResponseTypes: ["ReportBatchItemFailures"], ScalingConfig: { MaximumConcurrency: ref("MaximumConcurrency") } },
    },
    ScheduleGroup: { Type: "AWS::Scheduler::ScheduleGroup", Properties: { Name: name("jobs") } },
    SchedulerRole: {
      Type: "AWS::IAM::Role",
      Properties: {
        RoleName: name("jobs-scheduler"),
        AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "scheduler.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": ref("AWS::AccountId") }, ArnEquals: { "aws:SourceArn": arn("ScheduleGroup") } } }] },
        Policies: [{ PolicyName: "publish-jobs", PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: actions("sqs:SendMessage"), Resource: [arn("Queue"), arn("SchedulerDeadLetters")] }] } }],
      },
    },
    Alerts: { Type: "AWS::SNS::Topic", Properties: { TopicName: name("jobs-alerts") } },
    AlertPolicy: { Type: "AWS::SNS::TopicPolicy", Properties: {
      Topics: [ref("Alerts")], PolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Allow", Principal: { Service: "cloudwatch.amazonaws.com" }, Action: "sns:Publish", Resource: ref("Alerts"),
        Condition: { StringEquals: { "aws:SourceAccount": ref("AWS::AccountId") }, ArnLike: { "aws:SourceArn": sub('arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:learnrecur-' + environment + '-*') } },
      }] },
    } },
  };

  // SQS requires exactly one resource per queue-policy statement.
  for (const queue of ["Queue", "DeadLetters", "SchedulerDeadLetters"]) {
    resources[`${queue}TransportPolicy`] = { Type: "AWS::SQS::QueuePolicy", Properties: {
      Queues: [ref(queue)], PolicyDocument: { Version: "2012-10-17", Statement: [{
        Effect: "Deny", Principal: "*", Action: "sqs:*", Resource: arn(queue), Condition: { Bool: { "aws:SecureTransport": "false" } },
      }] },
    } };
  }

  function alarm(id: string, properties: Record<string, unknown>, condition?: string) {
    resources[id] = { Type: "AWS::CloudWatch::Alarm", ...(condition ? { Condition: condition } : {}), Properties: {
      AlarmName: name(id), AlarmActions: [ref("Alerts")], OKActions: [ref("Alerts")],
      EvaluationPeriods: 1, TreatMissingData: "notBreaching", ComparisonOperator: "GreaterThanOrEqualToThreshold", Threshold: 1, Period: 300, Statistic: "Sum", ...properties,
    } };
  }
  alarm("QueueAge", { Namespace: "AWS/SQS", MetricName: "ApproximateAgeOfOldestMessage", Statistic: "Maximum", Threshold: 900, Dimensions: [{ Name: "QueueName", Value: name("jobs.fifo") }] });
  alarm("DeadLetterBacklog", { Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Statistic: "Maximum", Dimensions: [{ Name: "QueueName", Value: name("jobs-dlq.fifo") }] });
  if (environment === "production") alarm("SchedulerDeadLetterBacklog", { Namespace: "AWS/SQS", MetricName: "ApproximateNumberOfMessagesVisible", Statistic: "Maximum", Dimensions: [{ Name: "QueueName", Value: name("scheduler-dlq") }] });
  alarm("WorkerErrors", { Namespace: "AWS/Lambda", MetricName: "Errors", Dimensions: [{ Name: "FunctionName", Value: ref("Worker") }] });

  for (const definition of JOB_DEFINITIONS.filter((job) => job.schedule)) {
    const id = definition.id.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join("");
    const job = buildJobEnvelope(definition.name, { requestedAt: "2026-01-01T00:00:00Z" }, environment);
    const scheduledTime = "<aws.scheduler.scheduled-time>";
    resources[`${id}Schedule`] = { Type: "AWS::Scheduler::Schedule", Properties: {
      Name: name(definition.id), GroupName: ref("ScheduleGroup"), ScheduleExpression: definition.schedule,
      FlexibleTimeWindow: { Mode: "OFF" }, State: { "Fn::If": ["SchedulesEnabled", "ENABLED", "DISABLED"] },
      Target: { Arn: arn("Queue"), RoleArn: arn("SchedulerRole"), SqsParameters: { MessageGroupId: getJobMessageGroupId(job) },
        Input: JSON.stringify({ ...job, id: `${definition.id}-${scheduledTime}`, data: { requestedAt: scheduledTime } }),
        RetryPolicy: { MaximumEventAgeInSeconds: 3600, MaximumRetryAttempts: 5 }, DeadLetterConfig: { Arn: arn("SchedulerDeadLetters") },
      },
    } };
    const metricName = `${id}Completed`;
    const namespace = `LearnRecur/${environment}/Jobs`;
    resources[`${id}Metric`] = { Type: "AWS::Logs::MetricFilter", Properties: {
      LogGroupName: ref("WorkerLogGroup"),
      FilterPattern: `{ $.component = "background-jobs" && $.outcome = "completed" && $.name = "${definition.name}" }`,
      MetricTransformations: [{ MetricNamespace: namespace, MetricName: metricName, MetricValue: "1", DefaultValue: 0 }],
    } };
    const period = definition.id === "agent-access-maintenance" ? 600 : definition.id === "account-deletion-recovery" ? 1800 : 7200;
    if (environment === "production") alarm(`${id}Silence`, { Namespace: namespace, MetricName: metricName, Period: period, Threshold: 1, ComparisonOperator: "LessThanThreshold", TreatMissingData: "breaching" }, "SchedulesEnabled");
  }

  return {
    AWSTemplateFormatVersion: "2010-09-09", Description: `LearnRecur ${environment} background jobs`,
    Parameters: {
      CodeBucket: { Type: "String" }, CodeKey: { Type: "String" }, SourceBucketName: { Type: "String" },
      ConfigurationRevision: { Type: "String", AllowedPattern: "[a-zA-Z0-9-]{1,80}" },
      EnableSchedules: { Type: "String", AllowedValues: ["true", "false"], Default: "false" },
      MaximumConcurrency: { Type: "Number", Default: environment === "production" ? 5 : 2, MinValue: 2, MaxValue: 5 },
    },
    Conditions: { SchedulesEnabled: { "Fn::Equals": [ref("EnableSchedules"), "true"] } },
    Resources: resources,
    Outputs: { QueueUrl: { Value: ref("Queue") }, QueueArn: { Value: arn("Queue") }, WorkerName: { Value: ref("Worker") }, AlertTopicArn: { Value: ref("Alerts") }, DeadLetterQueueUrl: { Value: ref("DeadLetters") }, SchedulerDeadLetterQueueUrl: { Value: ref("SchedulerDeadLetters") } },
  };
}
