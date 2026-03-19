/**
 * Trigger.dev v3 Client Configuration
 *
 * In Trigger.dev v3, the client is configured via environment variables
 * (TRIGGER_API_KEY, TRIGGER_API_URL) and the `configure` function.
 * Tasks are defined using `task()` from "@trigger.dev/sdk/v3".
 *
 * Environment variables consumed:
 *   TRIGGER_API_KEY       - API key for Trigger.dev
 *   TRIGGER_API_URL       - Self-hosted Trigger.dev API endpoint
 *   TRIGGER_PROJECT_ID    - Project identifier
 */

import { configure } from "@trigger.dev/sdk/v3";

// Configure the Trigger.dev v3 runtime. This must be called before any
// task definitions are registered. In v3 the SDK reads TRIGGER_SECRET_KEY
// and TRIGGER_API_URL from the environment automatically, but we call
// configure() explicitly so the values are validated at startup.
configure({
  secretKey: process.env.TRIGGER_API_KEY,
  baseURL: process.env.TRIGGER_API_URL ?? "http://localhost:3030",
});

/**
 * Project metadata re-exported for use in task definitions.
 */
export const PROJECT_ID = process.env.TRIGGER_PROJECT_ID ?? "aurelius-workbench";

/**
 * Shared task configuration defaults applied to every task via the
 * `retry` and `machine` options in `task()`.
 */
export const TASK_DEFAULTS = {
  /** Maximum number of retry attempts on transient failure */
  maxRetries: 3,
  /** Factor for exponential back-off between retries */
  retryBackoffFactor: 2,
  /** Minimum delay between retries in seconds */
  retryMinDelaySeconds: 1,
  /** Maximum delay between retries in seconds */
  retryMaxDelaySeconds: 60,
  /** Default task timeout in seconds (5 minutes) */
  timeoutSeconds: 300,
} as const;

/**
 * MinIO client configuration for artifact access within tasks.
 * These are used by task code to talk to the MinIO S3 API directly.
 */
export const MINIO_CONFIG = {
  endPoint: process.env.MINIO_ENDPOINT?.replace(/^https?:\/\//, "") ?? "minio",
  port: parseInt(process.env.MINIO_PORT ?? "9000", 10),
  useSSL: process.env.MINIO_USE_SSL === "true",
  accessKey: process.env.MINIO_USER ?? "aurelius",
  secretKey: process.env.MINIO_PASSWORD ?? "changeme123",
} as const;

/**
 * OPA client configuration for policy evaluation within tasks.
 */
export const OPA_CONFIG = {
  endpoint: process.env.OPA_ENDPOINT ?? "http://opa:8181",
} as const;
