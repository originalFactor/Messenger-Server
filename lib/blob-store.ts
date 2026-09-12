/*
 * Copyright 2026 ECSDevs
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

import { env } from "@/lib/env";
import { BlobPreconditionFailedError } from "@/lib/blob-error";
import { fsBlobStore } from "@/lib/blob-fs";
import { vercelBlobStore } from "@/lib/blob-vercel";

export { BlobPreconditionFailedError } from "@/lib/blob-error";

/**
 * 可插拔 Blob 存储层：
 * - `vercel` 后端：直通 vercel-blob-nonvercel SDK，行为与历史实现完全一致，
 *   用于 Vercel 部署（或任何配置了 BLOB_READ_WRITE_TOKEN 的环境）；
 * - `fs` 后端：自研文件系统存储（BLOB_STORAGE_DIR，默认 ./.blobs），是本地
 *   vercel-blob-emu emulator 的正式替代，也是自托管部署的默认选择。
 *
 * `BLOB_BACKEND=auto`（默认）：设置了 BLOB_READ_WRITE_TOKEN → vercel，否则 → fs。
 */

export interface BlobPutResult {
  /** 存取引用：vercel 后端为完整 URL，fs 后端等于 pathname。 */
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
  readonly backend: "fs" | "vercel";
  /**
   * 写入 blob。pathname 为逻辑路径；返回的 url 供 del 与 DB 引用使用
   * （同一次部署生命周期内保持同后端）。
   */
  put(pathname: string, body: Buffer, options?: { contentType?: string | null }): Promise<BlobPutResult>;
  /** 读取 blob。入参为逻辑 pathname；304 表示 ifNoneMatch 命中，无内容流。 */
  get(pathname: string, options?: { ifNoneMatch?: string | null }): Promise<BlobGetResult | null>;
  /** 删除 blob。url 必须来自本后端的 put/list 返回值。 */
  del(url: string, options?: { ifMatch?: string | null }): Promise<void>;
  /** 按前缀列出 blob（后端内部翻页拉满，对调用方一次性返回）。 */
  list(options: { prefix: string }): Promise<BlobListResult>;
}

/**
 * 把存量 DB 引用（旧 SDK 写入的完整 URL，或裸 pathname）规范化为逻辑路径：
 * 定位路径中的 `avatars/` 段并从该处截取，因此对任意存储域名/前缀都成立。
 * 纯逻辑路径（anchor === 0 或 -1）原样返回。
 */
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

let cachedStore: BlobStore | null = null;

export function getBlobStore(): BlobStore {
  if (cachedStore === null) {
    const backend = env.blobBackend();
    if (backend === "vercel") {
      cachedStore = vercelBlobStore;
    } else if (backend === "fs") {
      cachedStore = fsBlobStore;
    } else {
      // auto（以及任何未知值）：有 Vercel 凭据走 Vercel，否则走文件系统。
      cachedStore = env.blobReadWriteToken() ? vercelBlobStore : fsBlobStore;
    }
  }
  return cachedStore;
}
