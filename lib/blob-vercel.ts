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

import {
  BlobPreconditionFailedError as SdkBlobPreconditionFailedError,
  del as sdkDel,
  get as sdkGet,
  list as sdkList,
  put as sdkPut,
} from "vercel-blob-nonvercel";
import { BlobPreconditionFailedError } from "@/lib/blob-error";
import type {
  BlobGetResult,
  BlobListResult,
  BlobPutResult,
  BlobStore,
} from "@/lib/blob-store";

/**
 * Vercel Blob 后端：对 vercel-blob-nonvercel 的直通封装，调用参数与
 * 历史实现完全一致（access=private、addRandomSuffix=false、
 * cacheControlMaxAge=60、useCache=false），保证 Vercel 部署路径零行为
 * 变化、存量数据零迁移。SDK 的错误类型在此转译为公共错误类型，
 * 其余模块不直接接触 SDK。
 */

export const vercelBlobStore: BlobStore = {
  backend: "vercel",

  async put(pathname, body, options): Promise<BlobPutResult> {
    const result = await sdkPut(pathname, body, {
      access: "private",
      addRandomSuffix: false,
      ...(options?.contentType ? { contentType: options.contentType } : {}),
      cacheControlMaxAge: 60,
    });
    return {
      url: result.url,
      pathname: result.pathname,
      etag: result.etag,
      contentType: result.contentType ?? options?.contentType ?? null,
    };
  },

  async get(pathname, options): Promise<BlobGetResult | null> {
    const result = await sdkGet(pathname, {
      access: "private",
      useCache: false,
      ...(options?.ifNoneMatch ? { ifNoneMatch: options.ifNoneMatch } : {}),
    });
    if (!result) {
      return null;
    }
    return {
      statusCode: result.statusCode,
      blob: {
        pathname: result.blob.pathname,
        etag: result.blob.etag,
        contentType: result.blob.contentType,
        size: result.blob.size,
      },
      stream: result.stream,
    };
  },

  async del(url, options): Promise<void> {
    try {
      await sdkDel(url, options?.ifMatch ? { ifMatch: options.ifMatch } : undefined);
    } catch (error) {
      if (error instanceof SdkBlobPreconditionFailedError) {
        throw new BlobPreconditionFailedError(error.message);
      }
      throw error;
    }
  },

  async list(options): Promise<BlobListResult> {
    // 后端内部翻页拉满，对调用方一次性返回（头像前缀下文件数很小）。
    const blobs: Awaited<ReturnType<BlobStore["list"]>>["blobs"] = [];
    let cursor: string | undefined;
    do {
      const page = await sdkList({ prefix: options.prefix, cursor });
      blobs.push(
        ...page.blobs.map((blob) => ({
          url: blob.url,
          pathname: blob.pathname,
          etag: blob.etag,
          // list 结果不含 contentType；snapshot 流程经由 get 获取。
          contentType: null,
          size: blob.size,
        })),
      );
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return { blobs, hasMore: false };
  },
};
