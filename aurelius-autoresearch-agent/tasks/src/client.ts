/**
 * Trigger.dev Client Setup
 *
 * Configures the Trigger.dev client with project credentials
 * and shared runtime options for all task definitions.
 */

import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "aurelius-workbench",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL ?? "http://localhost:3030",
});

/**
 * Shared task configuration defaults.
 */
export const TASK_DEFAULTS = {
  /** Maximum number of retries on transient failure */
  maxRetries: 3,
  /** Base delay between retries (exponential backoff) */
  retryDelayMs: 1_000,
  /** Default task timeout */
  timeoutMs: 300_000, // 5 minutes
} as const;

/**
 * MinIO client configuration for artifact access within tasks.
 */
export const MINIO_CONFIG = {
  endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000",
  accessKey: process.env.MINIO_USER ?? "aurelius",
  secretKey: process.env.MINIO_PASSWORD ?? "changeme123",
} as const;

/**
 * OPA client configuration for policy evaluation within tasks.
 */
export const OPA_CONFIG = {
  endpoint: process.env.OPA_ENDPOINT ?? "http://opa:8181",
} as const;
