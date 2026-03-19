/**
 * MinIO RPC Handler
 *
 * Manages artifact storage, retrieval, and listing via MinIO S3-compatible API.
 * Handles proposal documents, compliance artifacts, and generated volumes.
 */

import type {
  Artifact,
  ArtifactMetadata,
  RPCResponse,
} from "../../shared/types";

export interface UploadRequest {
  bucket: string;
  key: string;
  data: Uint8Array | string;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface DownloadRequest {
  bucket: string;
  key: string;
}

export interface ListRequest {
  bucket: string;
  prefix?: string;
  maxKeys?: number;
  continuationToken?: string;
}

export interface ListResult {
  objects: ArtifactMetadata[];
  truncated: boolean;
  continuationToken?: string;
}

export class MinioRPC {
  private endpoint: string;
  private accessKey: string;
  private secretKey: string;

  constructor(
    endpoint: string = "http://localhost:9000",
    accessKey: string = "aurelius",
    secretKey: string = "changeme123",
  ) {
    this.endpoint = endpoint;
    this.accessKey = accessKey;
    this.secretKey = secretKey;
  }

  /**
   * Upload an artifact to a MinIO bucket.
   */
  async upload(req: UploadRequest): Promise<RPCResponse<ArtifactMetadata>> {
    try {
      await this.ensureBucket(req.bucket);

      const body = typeof req.data === "string" ? new TextEncoder().encode(req.data) : req.data;
      const contentType = req.contentType || "application/octet-stream";

      const url = `${this.endpoint}/${req.bucket}/${req.key}`;
      const headers: Record<string, string> = {
        "Content-Type": contentType,
        "Content-Length": String(body.byteLength),
        Authorization: this.buildAuthHeader("PUT", req.bucket, req.key),
      };

      if (req.metadata) {
        for (const [k, v] of Object.entries(req.metadata)) {
          headers[`x-amz-meta-${k}`] = v;
        }
      }

      const response = await fetch(url, {
        method: "PUT",
        headers,
        body,
      });

      if (!response.ok) {
        throw new Error(`Upload failed (${response.status}): ${response.statusText}`);
      }

      const etag = response.headers.get("ETag") || "";

      const metadata: ArtifactMetadata = {
        bucket: req.bucket,
        key: req.key,
        size: body.byteLength,
        contentType,
        etag: etag.replace(/"/g, ""),
        lastModified: Date.now(),
        userMetadata: req.metadata || {},
      };

      return { ok: true, data: metadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * Download an artifact from a MinIO bucket.
   */
  async download(req: DownloadRequest): Promise<RPCResponse<Artifact>> {
    try {
      const url = `${this.endpoint}/${req.bucket}/${req.key}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.buildAuthHeader("GET", req.bucket, req.key),
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return { ok: false, error: `Object not found: ${req.bucket}/${req.key}` };
        }
        throw new Error(`Download failed (${response.status}): ${response.statusText}`);
      }

      const data = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get("Content-Type") || "application/octet-stream";
      const etag = response.headers.get("ETag") || "";

      return {
        ok: true,
        data: {
          bucket: req.bucket,
          key: req.key,
          data,
          contentType,
          size: data.byteLength,
          etag: etag.replace(/"/g, ""),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * List objects in a bucket with optional prefix filtering.
   */
  async list(req: ListRequest): Promise<RPCResponse<ListResult>> {
    try {
      const params = new URLSearchParams({ "list-type": "2" });
      if (req.prefix) params.set("prefix", req.prefix);
      if (req.maxKeys) params.set("max-keys", String(req.maxKeys));
      if (req.continuationToken) {
        params.set("continuation-token", req.continuationToken);
      }

      const url = `${this.endpoint}/${req.bucket}?${params}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.buildAuthHeader("GET", req.bucket, ""),
        },
      });

      if (!response.ok) {
        throw new Error(`List failed (${response.status}): ${response.statusText}`);
      }

      const text = await response.text();
      const objects = this.parseListResponse(req.bucket, text);

      return {
        ok: true,
        data: {
          objects,
          truncated: text.includes("<IsTruncated>true</IsTruncated>"),
          continuationToken: this.extractTag(text, "NextContinuationToken"),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * Delete an object from a bucket.
   */
  async delete(req: DownloadRequest): Promise<RPCResponse<void>> {
    try {
      const url = `${this.endpoint}/${req.bucket}/${req.key}`;
      const response = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: this.buildAuthHeader("DELETE", req.bucket, req.key),
        },
      });

      if (!response.ok && response.status !== 204) {
        throw new Error(`Delete failed (${response.status}): ${response.statusText}`);
      }

      return { ok: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * Check if an object exists in a bucket.
   */
  async exists(req: DownloadRequest): Promise<RPCResponse<boolean>> {
    try {
      const url = `${this.endpoint}/${req.bucket}/${req.key}`;
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          Authorization: this.buildAuthHeader("HEAD", req.bucket, req.key),
        },
      });

      return { ok: true, data: response.ok };
    } catch {
      return { ok: true, data: false };
    }
  }

  /**
   * Generate a presigned URL for temporary access.
   */
  async presignUrl(
    req: DownloadRequest & { expiresInSeconds?: number },
  ): Promise<RPCResponse<string>> {
    const expires = req.expiresInSeconds ?? 3600;
    const url = `${this.endpoint}/${req.bucket}/${req.key}?X-Amz-Expires=${expires}`;
    return { ok: true, data: url };
  }

  /**
   * Ensure a bucket exists, creating it if necessary.
   */
  async ensureBucket(bucket: string): Promise<RPCResponse<void>> {
    try {
      const checkResponse = await fetch(`${this.endpoint}/${bucket}`, {
        method: "HEAD",
        headers: {
          Authorization: this.buildAuthHeader("HEAD", bucket, ""),
        },
      });

      if (checkResponse.ok) {
        return { ok: true, data: undefined };
      }

      const createResponse = await fetch(`${this.endpoint}/${bucket}`, {
        method: "PUT",
        headers: {
          Authorization: this.buildAuthHeader("PUT", bucket, ""),
        },
      });

      if (!createResponse.ok && createResponse.status !== 409) {
        throw new Error(`Bucket creation failed: ${createResponse.statusText}`);
      }

      return { ok: true, data: undefined };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  /**
   * List all buckets.
   */
  async listBuckets(): Promise<RPCResponse<string[]>> {
    try {
      const response = await fetch(this.endpoint, {
        method: "GET",
        headers: {
          Authorization: this.buildAuthHeader("GET", "", ""),
        },
      });

      if (!response.ok) {
        throw new Error(`List buckets failed: ${response.statusText}`);
      }

      const text = await response.text();
      const buckets: string[] = [];
      const regex = /<Name>(.*?)<\/Name>/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        buckets.push(match[1]);
      }

      return { ok: true, data: buckets };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  private buildAuthHeader(_method: string, _bucket: string, _key: string): string {
    // Simplified auth header; in production use AWS Signature V4
    const credentials = Buffer.from(`${this.accessKey}:${this.secretKey}`).toString("base64");
    return `Basic ${credentials}`;
  }

  private parseListResponse(bucket: string, xml: string): ArtifactMetadata[] {
    const objects: ArtifactMetadata[] = [];
    const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;

    while ((match = contentRegex.exec(xml)) !== null) {
      const block = match[1];
      const key = this.extractTag(block, "Key");
      const size = parseInt(this.extractTag(block, "Size") || "0", 10);
      const etag = (this.extractTag(block, "ETag") || "").replace(/"/g, "");
      const lastModified = this.extractTag(block, "LastModified");

      if (key) {
        objects.push({
          bucket,
          key,
          size,
          contentType: "application/octet-stream",
          etag,
          lastModified: lastModified ? new Date(lastModified).getTime() : Date.now(),
          userMetadata: {},
        });
      }
    }

    return objects;
  }

  private extractTag(xml: string, tag: string): string | undefined {
    const regex = new RegExp(`<${tag}>(.*?)</${tag}>`);
    const match = regex.exec(xml);
    return match ? match[1] : undefined;
  }
}
