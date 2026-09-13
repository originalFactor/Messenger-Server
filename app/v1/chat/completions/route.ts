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

import { NextResponse } from "next/server";
import { authenticateAiKey, estimatePromptTokens, joinUpstreamUrl, openAiError } from "@/lib/ai-proxy";
import { computeCost, quotaState } from "@/lib/quota";
import { consumeQuota, listUpstreamsForModel, recordUsage } from "@/lib/storage";
import { getModelDefaults } from "@/lib/model-metadata";
import type { UpstreamDoc } from "@/lib/types";

export const runtime = "nodejs";
// 流式对话可能远超默认时长；Vercel 会按套餐静默钳制该上限。
export const maxDuration = 60;

const UPSTREAM_TIMEOUT_MS = 120_000;

interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export async function POST(request: Request) {
  const user = await authenticateAiKey(request);
  if (!user) {
    return openAiError("Invalid API key.", 401, { type: "authentication_error", code: "invalid_api_key" });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
    return openAiError("Invalid request: 'model' and 'messages' are required.", 400);
  }
  const model = body.model;
  const stream = body.stream === true;

  const quota = quotaState(user.quotaBalance, user.quotaExpiresAt);
  if (!quota.available) {
    return openAiError(
      quota.reason === "expired"
        ? "Your plan has expired. Redeem a new card key to continue."
        : "Insufficient quota. Redeem a card key to top up.",
      402,
      { type: "insufficient_quota" },
    );
  }

  const upstreams = await listUpstreamsForModel(model);
  if (upstreams.length === 0) {
    return openAiError(`Model '${model}' has no available upstream.`, 404, { code: "model_not_found" });
  }

  const promptTokens = estimatePromptTokens(body.messages);
  const defaults = await getModelDefaults();
  const settle = {
    userId: user.id,
    modelId: model,
    promptTokens,
    defaults: { contextSizes: defaults.contextSizes, rates: defaults.rates },
  };

  if (stream) {
    return streamProxy(body, upstreams, settle);
  }
  return nonStreamProxy(body, upstreams, settle);
}

interface SettleParams {
  userId: string;
  modelId: string;
  promptTokens: number;
  defaults: { contextSizes: Record<string, number>; rates: Record<string, { input: number; output: number }> };
}

interface ResolvedModelMeta {
  contextWindow: number;
  inputRate: number;
  outputRate: number;
}

/**
 * 元数据解析：上游开启元数据覆盖时使用其自定义值（缺失字段回退
 * models.dev），关闭时直接使用 models.dev 元数据；无数据一律置零
 * （contextWindow 0 = 不限制，倍率 0 = 不计费）。
 */
function resolveModelMeta(upstream: UpstreamDoc, model: string, defaults: SettleParams["defaults"]): ResolvedModelMeta {
  const devContext = defaults.contextSizes[model];
  const devRate = defaults.rates[model];
  if (upstream.metaOverride) {
    const custom = upstream.modelMeta?.[model];
    return {
      contextWindow: custom?.contextWindow ?? devContext ?? 0,
      inputRate: custom?.inputRate ?? devRate?.input ?? 0,
      outputRate: custom?.outputRate ?? devRate?.output ?? 0,
    };
  }
  return {
    contextWindow: devContext ?? 0,
    inputRate: devRate?.input ?? 0,
    outputRate: devRate?.output ?? 0,
  };
}

/**
 * 请求完成后按 usage 扣减额度并记录用量。usage 缺失时按完成文本的
 * 字符长度估算 completion tokens。失败只记日志，不影响响应送达。
 */
async function settleUsage(
  params: SettleParams & {
    inputRate: number;
    outputRate: number;
    upstreamId: string | null;
    usage: UsageShape | null;
    completionChars: number;
    stream: boolean;
  },
): Promise<void> {
  const usage = params.usage;
  const completionTokens = usage?.completion_tokens ?? Math.ceil(params.completionChars / 4);
  const totalTokens = usage?.total_tokens ?? (usage?.prompt_tokens ?? params.promptTokens) + completionTokens;
  const cost = computeCost(
    usage?.prompt_tokens ?? params.promptTokens,
    completionTokens,
    params.inputRate,
    params.outputRate,
  );
  try {
    await consumeQuota(params.userId, cost);
    await recordUsage({
      userId: params.userId,
      modelId: params.modelId,
      upstreamId: params.upstreamId,
      promptTokens: usage?.prompt_tokens ?? params.promptTokens,
      completionTokens,
      totalTokens,
      cost,
      stream: params.stream,
    });
  } catch (error) {
    console.error("Unable to settle usage after completion.", error);
  }
}

function forwardHeaders(upstream: UpstreamDoc): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${upstream.apiKey}` };
}

function passthroughUpstreamError(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
  });
}

async function nonStreamProxy(
  body: Record<string, unknown>,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
): Promise<Response> {
  for (const upstream of upstreams) {
    let response: Response;
    try {
      response = await fetch(joinUpstreamUrl(upstream.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: forwardHeaders(upstream),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("Upstream request failed.", { upstreamId: upstream._id, error });
      continue;
    }

    // 5xx 视为上游故障，切换下一个上游；4xx 一般是调用方参数问题，原样透传。
    if (response.status >= 500) {
      continue;
    }
    if (!response.ok) {
      return passthroughUpstreamError(response);
    }

    const payload = (await response.json().catch(() => null)) as (Record<string, unknown> & { usage?: UsageShape }) | null;
    if (!payload) {
      continue;
    }

    await settleUsage({
      ...settle,
      ...resolveModelMeta(upstream, settle.modelId, settle.defaults),
      upstreamId: upstream._id,
      usage: payload.usage ?? null,
      completionChars: extractCompletionChars(payload),
      stream: false,
    });
    return NextResponse.json(payload, { status: response.status });
  }

  return openAiError("Upstream model service is unavailable.", 502, { type: "api_error" });
}

function extractCompletionChars(payload: Record<string, unknown> & { usage?: UsageShape }): number {
  const choices = payload.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.length;
  }
  return content === undefined || content === null ? 0 : JSON.stringify(content).length;
}

async function streamProxy(
  body: Record<string, unknown>,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
): Promise<Response> {
  // 强制上游返回 usage（OpenAI 兼容服务的标准扩展）；部分上游不支持时
  // 由 sniff 到的增量文本长度兜底估算。
  const forwardBody = { ...body, stream: true, stream_options: { include_usage: true } };

  for (const upstream of upstreams) {
    let response: Response;
    try {
      response = await fetch(joinUpstreamUrl(upstream.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: forwardHeaders(upstream),
        body: JSON.stringify(forwardBody),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("Upstream stream request failed.", { upstreamId: upstream._id, error });
      continue;
    }
    if (response.status >= 500) {
      continue;
    }
    if (!response.ok && response.body) {
      return passthroughUpstreamError(response);
    }
    if (!response.body) {
      continue;
    }
    return buildStreamingResponse(response, upstream, settle);
  }

  return openAiError("Upstream model service is unavailable.", 502, { type: "api_error" });
}

function buildStreamingResponse(response: Response, upstream: UpstreamDoc, settle: SettleParams): Response {
  const decoder = new TextDecoder();
  let buffer = "";
  const sniffed = { usage: null as UsageShape | null, completionChars: 0 };

  const sniffLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(payload) as {
        usage?: UsageShape;
        choices?: Array<{ delta?: { content?: unknown } }>;
      };
      if (parsed.usage) {
        sniffed.usage = parsed.usage;
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string") {
        sniffed.completionChars += delta.length;
      }
    } catch {
      // 忽略无法解析的心跳/注释行。
    }
  };

  const stream = response.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // 字节原样透传给客户端，旁路只做行级嗅探。
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        sniffLine(line);
      }
    },
    async flush() {
      if (buffer) {
        sniffLine(buffer);
      }
      await settleUsage({
        ...settle,
        ...resolveModelMeta(upstream, settle.modelId, settle.defaults),
        upstreamId: upstream._id,
        usage: sniffed.usage,
        completionChars: sniffed.completionChars,
        stream: true,
      });
    },
  }));

  return new Response(stream, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
