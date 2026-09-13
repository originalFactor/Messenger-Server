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

import { z } from "zod";

/**
 * models.dev 公开模型元数据（https://models.dev/models.json）：以模型 ID
 * 为键的扁平映射（如 "openai/gpt-4o"），limit.context 即上下文窗口。
 * 上游 /v1/models 返回的是裸 ID（"gpt-4o"），因此除完整键外同时登记
 * "/" 后的短键，命中优先取完整键。结果在实例内存中缓存 24 小时；
 * 拉取失败时回退到上一次缓存，永远不抛出（元数据仅用于展示）。
 */

const MODELS_DEV_URL = "https://models.dev/models.json";
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const METADATA_TIMEOUT_MS = 10_000;

const modelsDevSchema = z.record(
  z.string(),
  z.object({
    // 部分条目（图像模型等）的 context 为 0，校验放宽为任意数字，
    // 构建映射时跳过非正值。
    limit: z
      .object({
        context: z.number(),
      })
      .partial()
      .optional(),
  }),
);

export type ModelContextSizes = Record<string, number>;

interface MetadataCache {
  data: ModelContextSizes;
  fetchedAt: number;
}

let cache: MetadataCache | null = null;
let inflight: Promise<ModelContextSizes> | null = null;

export async function getModelContextSizes(): Promise<ModelContextSizes> {
  if (cache && Date.now() - cache.fetchedAt < METADATA_TTL_MS) {
    return cache.data;
  }
  if (inflight) {
    return inflight;
  }
  inflight = fetchMetadata()
    .then((data) => {
      cache = { data, fetchedAt: Date.now() };
      return data;
    })
    .catch(() => cache?.data ?? ({} as ModelContextSizes))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function fetchMetadata(): Promise<ModelContextSizes> {
  const response = await fetch(MODELS_DEV_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`models.dev returned ${response.status}`);
  }
  const parsed = modelsDevSchema.parse(await response.json());

  const sizes: ModelContextSizes = {};
  for (const [key, model] of Object.entries(parsed)) {
    const context = model.limit?.context;
    if (!context) {
      continue;
    }
    sizes[key] = Math.max(sizes[key] ?? 0, context);
    const separator = key.indexOf("/");
    if (separator > 0) {
      const bareId = key.slice(separator + 1);
      sizes[bareId] = Math.max(sizes[bareId] ?? 0, context);
    }
  }
  return sizes;
}
