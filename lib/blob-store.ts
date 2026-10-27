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

import { s3BlobStore } from "@/lib/blob-s3";

export { BlobPreconditionFailedError } from "@/lib/blob-error";

/** S3-compatible avatar storage boundary. */

export interface BlobPutResult {
  /** Storage reference, equal to the S3 object key. */
  url: string;
  /** 逻辑路径（avatars/...）。 */
  pathname: string;
  etag: string;
  contentType: string | null;
}

export interface BlobGetResult {
  statusCode: 200 | 304;
  blob: {
    pathname: string;
    etag: string;
    contentType: string | null;
    size: number | null;
  };
  stream?: ReadableStream<Uint8Array> | null;
}

export interface BlobMeta {
  url: string;
  pathname: string;
  etag: string;
  contentType: string | null;
  size: number;
}

export interface BlobListResult {
  blobs: BlobMeta[];
  hasMore: boolean;
}

export interface BlobStore {
  readonly backend: "s3";
  /**
   * Write a blob at its logical pathname; its key is used as the DB reference.
   */
  put(pathname: string, body: Buffer, options?: { contentType?: string | null }): Promise<BlobPutResult>;
  /** 读取 blob。入参为逻辑 pathname；304 表示 ifNoneMatch 命中，无内容流。 */
  get(pathname: string, options?: { ifNoneMatch?: string | null }): Promise<BlobGetResult | null>;
  /** 删除 blob。url 必须来自本后端的 put/list 返回值。 */
  del(url: string, options?: { ifMatch?: string | null }): Promise<void>;
  /** 按前缀列出 blob（后端内部翻页拉满，对调用方一次性返回）。 */
  list(options: { prefix: string }): Promise<BlobListResult>;
}

/** Normalize a stored avatar reference to its logical pathname. */
export function blobPathFromUrl(urlOrPath: string): string {
  let pathname = urlOrPath.trim();
  if (/^https?:\/\//i.test(pathname)) {
    pathname = new URL(pathname).pathname;
  }
  pathname = decodeURIComponent(pathname).replace(/\\/g, "/").replace(/^\/+/, "");
  const anchor = pathname.lastIndexOf("avatars/");
  if (anchor > 0) {
    pathname = pathname.slice(anchor);
  }
  return pathname;
}

export function getBlobStore(): BlobStore {
  return s3BlobStore;
}
