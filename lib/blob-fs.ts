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

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { BlobPreconditionFailedError } from "@/lib/blob-error";
import { env } from "@/lib/env";
import type { BlobGetResult, BlobListResult, BlobPutResult, BlobStore } from "@/lib/blob-store";

/**
 * 文件系统 Blob 后端：vercel-blob-emu emulator 的正式替代。
 *
 * 布局：内容写 `BLOB_STORAGE_DIR/{pathname}`（默认 `./.blobs`），元数据
 * （sha256 ETag / Content-Type / 上传时间）写 `{pathname}.meta.json` sidecar。
 * sidecar 缺失时（例如从旧存储目录手工迁移文件）读取端按内容现算 ETag、
 * 按扩展名推导 Content-Type，因此把旧 `avatars/` 文件树整目录拷贝进来
 * 即可完成迁移；`url` 与 `pathname` 等价。
 */

interface BlobSidecar {
  etag: string;
  contentType: string | null;
  uploadedAt: number;
}

const META_SUFFIX = ".meta.json";
const KNOWN_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

let cachedRoot: string | null = null;

function storageRoot(): string {
  if (cachedRoot === null) {
    cachedRoot = path.resolve(env.blobStorageDir());
  }
  return cachedRoot;
}

function resolveTarget(pathname: string): string {
  const normalized = pathname.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    throw new Error(`Invalid blob pathname: ${pathname}`);
  }
  const target = path.join(storageRoot(), ...normalized.split("/"));
  if (!target.startsWith(storageRoot() + path.sep)) {
    throw new Error(`Invalid blob pathname: ${pathname}`);
  }
  return target;
}

function metaPathFor(target: string): string {
  return `${target}${META_SUFFIX}`;
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function guessContentType(pathname: string): string | null {
  const extension = pathname.split("/").pop()?.split(".").pop()?.toLowerCase();
  return (extension && KNOWN_CONTENT_TYPES[extension]) || null;
}

/** HTTP 条件头的宽松比较：忽略 W/ 前缀与引号。 */
function etagMatches(candidate: string, etag: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
  return normalize(candidate) === normalize(etag);
}

async function readSidecar(target: string): Promise<BlobSidecar | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(metaPathFor(target), "utf8")) as BlobSidecar;
    return typeof parsed?.etag === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSidecar(target: string, sidecar: BlobSidecar): Promise<void> {
  await fs.writeFile(metaPathFor(target), JSON.stringify(sidecar), "utf8");
}

export const fsBlobStore: BlobStore = {
  backend: "fs",

  async put(pathname, body, options): Promise<BlobPutResult> {
    if (body.length === 0) {
      throw new Error("Blob content must not be empty.");
    }
    const etag = sha256Hex(body);
    const contentType = options?.contentType ?? guessContentType(pathname);
    const target = resolveTarget(pathname);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // 先写临时文件再 rename，保证读取端永远看不到半截内容。
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);
    try {
      await fs.writeFile(temp, body);
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    await writeSidecar(target, { etag, contentType: contentType ?? null, uploadedAt: Date.now() });
    return { url: pathname, pathname, etag, contentType: contentType ?? null };
  },

  async get(pathname, options): Promise<BlobGetResult | null> {
    const target = resolveTarget(pathname);
    let content: Buffer;
    try {
      content = await fs.readFile(target);
    } catch {
      return null;
    }
    const sidecar = await readSidecar(target);
    const etag = sidecar?.etag ?? sha256Hex(content);
    const contentType = sidecar?.contentType ?? guessContentType(pathname);
    if (options?.ifNoneMatch && etagMatches(options.ifNoneMatch, etag)) {
      return { statusCode: 304, blob: { pathname, etag, contentType, size: null } };
    }
    return {
      statusCode: 200,
      blob: { pathname, etag, contentType, size: content.length },
      stream: Readable.toWeb(createReadStream(target)) as unknown as ReadableStream<Uint8Array>,
    };
  },

  async del(pathname, options): Promise<void> {
    const target = resolveTarget(pathname);
    if (options?.ifMatch) {
      const content = await fs.readFile(target).catch(() => null);
      if (content) {
        const sidecar = await readSidecar(target);
        const etag = sidecar?.etag ?? sha256Hex(content);
        if (!etagMatches(options.ifMatch, etag)) {
          throw new BlobPreconditionFailedError(
            `The blob at ${pathname} changed before it could be deleted.`,
          );
        }
      }
    }
    await fs.rm(target, { force: true });
    await fs.rm(metaPathFor(target), { force: true });
  },

  async list(options): Promise<BlobListResult> {
    const prefix = options.prefix.replace(/\\/g, "/");
    const root = storageRoot();
    const blobs: Awaited<ReturnType<BlobStore["list"]>>["blobs"] = [];
    let entries: Array<Dirent<string>> = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
    } catch {
      return { blobs, hasMore: false };
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const relative = path
        .relative(root, path.join(entry.parentPath ?? entry.path, entry.name))
        .replace(/\\/g, "/");
      if (relative.endsWith(META_SUFFIX) || relative.includes(".tmp-")) {
        continue;
      }
      if (!relative.startsWith(prefix)) {
        continue;
      }
      const target = path.join(root, relative);
      const content = await fs.readFile(target).catch(() => null);
      if (!content) {
        continue;
      }
      const sidecar = await readSidecar(target);
      blobs.push({
        url: relative,
        pathname: relative,
        etag: sidecar?.etag ?? sha256Hex(content),
        contentType: sidecar?.contentType ?? guessContentType(relative),
        size: content.length,
      });
    }
    blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));
    // 头像前缀下的文件个位数，无需分页。
    return { blobs, hasMore: false };
  },
};
