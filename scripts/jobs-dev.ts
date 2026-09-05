import { config as loadEnv } from "dotenv";
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSRecord } from "aws-lambda";
import { getJobsConfig } from "../src/lib/jobs/config";
import { getLocalWorkerFailureCode } from "../src/lib/jobs/diagnostics";

async function main() {
  loadEnv({ path: ".env.local", quiet: true });
  loadEnv({ path: ".env", quiet: true });
  const config = getJobsConfig();
  if (config.environment !== "local") throw new Error("JOB_LOCAL_ENVIRONMENT_REQUIRED");
  const { createRuntimeWorker, JOB_TIMEOUT_SECONDS } = await import("../src/lib/jobs/lambda");
  const worker = await createRuntimeWorker();
  const client = new SQSClient({ region: config.region });
  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());
  console.info("Local AWS job worker is listening.");
  try {
    while (!shutdown.signal.aborted) {
      const batch = await client.send(new ReceiveMessageCommand({
        QueueUrl: config.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
        VisibilityTimeout: JOB_TIMEOUT_SECONDS * 6,
        MessageSystemAttributeNames: ["All"], MessageAttributeNames: ["All"],
      }), { abortSignal: shutdown.signal });
      for (const message of batch.Messages ?? []) {
        if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined) throw new Error("JOB_RECEIVE_INVALID");
        const record: SQSRecord = {
          messageId: message.MessageId, receiptHandle: message.ReceiptHandle, body: message.Body,
          attributes: message.Attributes as SQSRecord["attributes"], messageAttributes: {},
          md5OfBody: message.MD5OfBody ?? "", eventSource: "aws:sqs", eventSourceARN: config.queueArn, awsRegion: config.region,
        };
        // Match Lambda's hard execution limit; stop the process so timed-out
        // business code cannot continue after its database lease expires.
        const timeout = setTimeout(() => { console.error("JOB_LOCAL_TIMEOUT"); process.exit(1); }, JOB_TIMEOUT_SECONDS * 1000);
        try {
          const response = await worker({ Records: [record] });
          if (!response.batchItemFailures.length) await client.send(new DeleteMessageCommand({ QueueUrl: config.queueUrl, ReceiptHandle: message.ReceiptHandle }));
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error("Local AWS worker stopped. Check AWS access and local job configuration.", { code: getLocalWorkerFailureCode(error) });
  process.exitCode = 1;
});
