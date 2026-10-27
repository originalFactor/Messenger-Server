/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { BlobPreconditionFailedError } from "@/lib/blob-error";
import type { BlobMeta, BlobStore } from "@/lib/blob-store";
import { env } from "@/lib/env";

let client: S3Client | undefined;

function s3(): S3Client {
  return client ??= new S3Client({
    region: env.s3Region(),
    endpoint: env.s3Endpoint(),
    forcePathStyle: env.s3ForcePathStyle(),
    credentials: env.s3Credentials(),
  });
}

type S3Error = {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  $response?: { headers?: Record<string, string | undefined> };
};

export const s3BlobStore: BlobStore = {
  backend: "s3",

  async put(pathname, body, options) {
    const result = await s3().send(new PutObjectCommand({
      Bucket: env.s3Bucket(),
      Key: pathname,
      Body: body,
      ...(options?.contentType ? { ContentType: options.contentType } : {}),
      CacheControl: "private, max-age=60",
    }));
    if (!result.ETag) throw new Error(`S3 did not return an ETag for ${pathname}`);
    return { url: pathname, pathname, etag: result.ETag, contentType: options?.contentType ?? null };
  },

  async get(pathname, options) {
    try {
      const result = await s3().send(new GetObjectCommand({
        Bucket: env.s3Bucket(),
        Key: pathname,
        ...(options?.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
      }));
      if (!result.ETag) throw new Error(`S3 did not return an ETag for ${pathname}`);
      return {
        statusCode: 200,
        blob: {
          pathname,
          etag: result.ETag,
          contentType: result.ContentType ?? null,
          size: result.ContentLength ?? null,
        },
        stream: result.Body?.transformToWebStream() ?? null,
      };
    } catch (error) {
      const s3Error = (error ?? {}) as S3Error;
      if (s3Error.$metadata?.httpStatusCode === 304 && options?.ifNoneMatch) {
        const etag = s3Error.$response?.headers?.etag;
        if (!etag) {
          // Some S3-compatible services omit ETag on 304. Fetch metadata rather
          // than the object, and recheck the condition in case it changed.
          try {
            const head = await s3().send(new HeadObjectCommand({
              Bucket: env.s3Bucket(),
              Key: pathname,
            }));
            const current = head.ETag;
            const matches = current && options.ifNoneMatch.split(",").some((value) => {
              const candidate = value.trim().replace(/^W\//, "");
              return candidate === "*" || candidate === current;
            });
            if (!matches || !current) return s3BlobStore.get(pathname);
            return {
              statusCode: 304,
              blob: { pathname, etag: current, contentType: head.ContentType ?? null, size: head.ContentLength ?? null },
            };
          } catch (headError) {
            const status = (headError as S3Error).$metadata?.httpStatusCode;
            if (status === 404) return null;
            throw headError;
          }
        }
        return {
          statusCode: 304,
          blob: {
            pathname,
            etag,
            contentType: null,
            size: null,
          },
        };
      }
      if (s3Error.name === "NoSuchKey" || s3Error.name === "NotFound") return null;
      throw error;
    }
  },

  async del(url, options) {
    try {
      await s3().send(new DeleteObjectCommand({
        Bucket: env.s3Bucket(),
        Key: url,
        ...(options?.ifMatch ? { IfMatch: options.ifMatch } : {}),
      }));
    } catch (error) {
      const s3Error = (error ?? {}) as S3Error;
      if (s3Error.$metadata?.httpStatusCode === 412 || s3Error.name === "PreconditionFailed") {
        throw new BlobPreconditionFailedError(s3Error.message ?? "S3 delete precondition failed");
      }
      throw error;
    }
  },

  async list(options) {
    const blobs: BlobMeta[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await s3().send(new ListObjectsV2Command({
        Bucket: env.s3Bucket(),
        Prefix: options.prefix,
        ContinuationToken: continuationToken,
      }));
      for (const object of page.Contents ?? []) {
        if (!object.Key || !object.ETag || object.Size == null) {
          throw new Error("S3 returned an incomplete object listing");
        }
        blobs.push({
          url: object.Key,
          pathname: object.Key,
          etag: object.ETag,
          contentType: null,
          size: object.Size,
        });
      }
      if (page.IsTruncated && !page.NextContinuationToken) {
        throw new Error("S3 returned a truncated listing without a continuation token");
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return { blobs, hasMore: false };
  },
};
