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

/**
 * /v1 代理的四协议共享管线：
 *
 *   客户端请求（chat / responses / messages / interactions）
 *     → IR（ai-formats.decodeClientRequest）
 *     → 上游请求（按上游 apiFormat 编码；auto = 跟随客户端格式）
 *     → 上游响应/SSE 解码为 IR
 *     → 客户端格式响应/SSE 编码
 *
 * 计费与用量记账沿用原 chat 代理语义：请求完成后按 usage 扣减额度，
 * usage 缺失时按完成文本字符数估算；5xx/连接失败切换下一个上游，
 * 4xx 原样透传（但错误体转换为客户端格式）。
 */

import { NextResponse } from "next/server";
import {
  type ApiFormat,
  type IrEvent,
  type IrRequest,
  type IrResponse,
  type IrUsage,
  type UpstreamApiFormat,
  createStreamDecoder,
  createStreamEncoder,
  decodeClientRequest,
  decodeUpstreamResponse,
  encodeClientResponse,
  encodeUpstreamRequest,
  estimateIrPromptTokens,
  formatErrorBody,
  formatPath,
  normalizeApiFormat,
  normalizeFinishReason,
  upstreamHeaders,
} from "@/lib/ai-formats";
import { authenticateAiKey } from "@/lib/ai-proxy";
import { getModelDefaults } from "@/lib/model-metadata";
import { computeCost } from "@/lib/quota";
import { consumeQuota, getUserQuotaState, listUpstreamsForModel, recordUsage } from "@/lib/storage";
import type { UpstreamDoc } from "@/lib/types";

export const UPSTREAM_TIMEOUT_MS = 120_000;

interface ModelDefaults {
  contextSizes: Record<string, number>;
  rates: Record<string, { input: number; output: number }>;
}

interface ResolvedModelMeta {
  contextWindow: number;
  inputRate: number;
  outputRate: number;
}

interface SettleParams {
  userId: string;
  modelId: string;
  promptTokens: number;
  defaults: ModelDefaults;
}

/**
 * 元数据解析（按模型）：该模型的 modelMeta.override 开启时使用其自定义值
 * （缺失字段回退 models.dev），否则直接使用 models.dev 元数据；倍率无数据
 * 时默认 1x（显式配置 0 = 不计费），contextWindow 0 = 不限制。
 */
function resolveModelMeta(upstream: UpstreamDoc, model: string, defaults: ModelDefaults): ResolvedModelMeta {
  const devContext = defaults.contextSizes[model];
  const devRate = defaults.rates[model];
  const custom = upstream.modelMeta?.[model];
  if (custom?.override) {
    return {
      contextWindow: custom.contextWindow ?? devContext ?? 0,
      inputRate: custom.inputRate ?? devRate?.input ?? 1,
      outputRate: custom.outputRate ?? devRate?.output ?? 1,
    };
  }
  return {
    contextWindow: devContext ?? 0,
    inputRate: devRate?.input ?? 1,
    outputRate: devRate?.output ?? 1,
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
    usage: IrUsage | null;
    completionChars: number;
    stream: boolean;
  },
): Promise<void> {
  const usage = params.usage;
  const completionTokens = usage?.completionTokens ?? Math.ceil(params.completionChars / 4);
  const promptTokens = usage?.promptTokens ?? params.promptTokens;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  const cost = computeCost(promptTokens, completionTokens, params.inputRate, params.outputRate);
  try {
    await consumeQuota(params.userId, cost);
    await recordUsage({
      userId: params.userId,
      modelId: params.modelId,
      upstreamId: params.upstreamId,
      promptTokens,
      completionTokens,
      totalTokens,
      cost,
      stream: params.stream,
    });
  } catch (error) {
    console.error("Unable to settle usage after completion.", error);
  }
}

/** 客户端格式的错误响应（Chat/Responses 为 OpenAI 体，Messages/Interactions 为各自体）。 */
export function clientError(
  format: ApiFormat,
  message: string,
  status: number,
  code = "invalid_request_error",
) {
  return NextResponse.json(formatErrorBody(format, message, code), { status });
}

/** 上游格式（`auto` 解析为客户端格式）。 */
function resolveUpstreamFormat(upstream: UpstreamDoc, clientFormat: ApiFormat): ApiFormat {
  const configured: UpstreamApiFormat = upstream.apiFormat ?? "auto";
  return configured === "auto" ? clientFormat : normalizeApiFormat(configured, clientFormat);
}

/** 4xx 错误体转换为客户端格式，保留上游 message 与状态码。 */
async function passthroughUpstreamError(
  response: Response,
  clientFormat: ApiFormat,
  upstreamFormat: ApiFormat,
): Promise<Response> {
  const raw = await response.text().catch(() => "");
  let message = raw || `Upstream returned ${response.status}.`;
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown; type?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") {
      message = parsed.error;
    } else if (parsed.error && typeof parsed.error.message === "string") {
      message = parsed.error.message;
    } else if (typeof parsed.message === "string") {
      message = parsed.message;
    }
  } catch {
    // 非 JSON 错误体按原文返回。
  }
  if (clientFormat === upstreamFormat) {
    return new Response(raw || JSON.stringify(formatErrorBody(clientFormat, message)), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  }
  return NextResponse.json(formatErrorBody(clientFormat, message, "upstream_error"), {
    status: response.status,
  });
}

function upstreamRequestBody(upstreamFormat: ApiFormat, ir: IrRequest): Record<string, unknown> {
  const body = encodeUpstreamRequest(upstreamFormat, ir);
  if (ir.stream && upstreamFormat === "chat") {
    // 强制上游返回 usage；不支持该扩展的上游会忽略它，由增量文本兜底估算。
    body.stream_options = { include_usage: true };
  }
  return body;
}

async function nonStreamProxy(
  clientFormat: ApiFormat,
  ir: IrRequest,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
): Promise<Response> {
  for (const upstream of upstreams) {
    const upstreamFormat = resolveUpstreamFormat(upstream, clientFormat);
    let response: Response;
    try {
      response = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}${formatPath(upstreamFormat)}`, {
        method: "POST",
        headers: upstreamHeaders(upstreamFormat, upstream.apiKey),
        body: JSON.stringify(upstreamRequestBody(upstreamFormat, { ...ir, stream: false })),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("Upstream request failed.", { upstreamId: upstream._id, error });
      continue;
    }

    // 5xx 视为上游故障，切换下一个上游；4xx 一般是调用方参数问题，透传。
    if (response.status >= 500) {
      continue;
    }
    if (!response.ok) {
      return passthroughUpstreamError(response, clientFormat, upstreamFormat);
    }

    const payload = await response.json().catch(() => null);
    if (!payload) {
      continue;
    }

    const decoded = decodeUpstreamResponse(upstreamFormat, payload);
    decoded.finishReason = normalizeFinishReason(decoded.finishReason);
    await settleUsage({
      ...settle,
      ...resolveModelMeta(upstream, settle.modelId, settle.defaults),
      upstreamId: upstream._id,
      usage: decoded.usage,
      completionChars: decoded.text.length,
      stream: false,
    });
    return NextResponse.json(encodeClientResponse(clientFormat, decoded, ir.model), {
      status: response.status,
    });
  }

  return clientError(clientFormat, "Upstream model service is unavailable.", 502, "api_error");
}

async function streamProxy(
  clientFormat: ApiFormat,
  ir: IrRequest,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
): Promise<Response> {
  for (const upstream of upstreams) {
    const upstreamFormat = resolveUpstreamFormat(upstream, clientFormat);
    let response: Response;
    try {
      response = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}${formatPath(upstreamFormat)}`, {
        method: "POST",
        headers: upstreamHeaders(upstreamFormat, upstream.apiKey),
        body: JSON.stringify(upstreamRequestBody(upstreamFormat, { ...ir, stream: true })),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      console.error("Upstream stream request failed.", { upstreamId: upstream._id, error });
      continue;
    }
    if (response.status >= 500) {
      continue;
    }
    if (!response.ok) {
      return passthroughUpstreamError(response, clientFormat, upstreamFormat);
    }
    if (!response.body) {
      continue;
    }
    return buildStreamingResponse(clientFormat, upstreamFormat, response, upstream, ir.model, settle);
  }

  return clientError(clientFormat, "Upstream model service is unavailable.", 502, "api_error");
}

/** Exported for the stream-conversion smoke test; the routes reach it via [relayCompletion]. */
export function buildStreamingResponse(
  clientFormat: ApiFormat,
  upstreamFormat: ApiFormat,
  response: Response,
  upstream: UpstreamDoc,
  model: string,
  settle: SettleParams,
): Response {
  const decoder = createStreamDecoder(upstreamFormat);
  const encoder = createStreamEncoder(clientFormat, model);
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();
  let buffer = "";
  const sniffed = {
    usage: null as IrUsage | null,
    completionChars: 0,
    finishReason: "stop",
    finished: false,
  };

  // Deltas go out as they arrive; the terminal event waits for the stream's
  // end so it can carry the usage chunk that providers send last.
  const emit = (event: IrEvent, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (event.type === "finish") {
      sniffed.finishReason = event.reason;
      return;
    }
    absorbEvent(event, sniffed);
    const out = encoder.push(event);
    if (out) controller.enqueue(textEncoder.encode(out));
  };

  const handlePayload = (payload: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (payload === "[DONE]") {
      sniffed.finished = true;
      return;
    }
    for (const event of decoder.feed(payload)) emit(event, controller);
  };

  const stream = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        const opening = encoder.start();
        if (opening) controller.enqueue(textEncoder.encode(opening));
      },
      transform(chunk, controller) {
        buffer += textDecoder.decode(chunk, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();
            if (payload) handlePayload(payload, controller);
          }
        }
      },
      async flush(controller) {
        const trailing = buffer.trim();
        if (trailing.startsWith("data:")) {
          const payload = trailing.slice(5).trim();
          if (payload) handlePayload(payload, controller);
        }
        for (const event of decoder.finish()) emit(event, controller);
        const terminal = encoder.push({ type: "finish", reason: sniffed.finishReason });
        if (terminal) controller.enqueue(textEncoder.encode(terminal));
        const closing = encoder.end();
        if (closing) controller.enqueue(textEncoder.encode(closing));
        await settleUsage({
          ...settle,
          ...resolveModelMeta(upstream, settle.modelId, settle.defaults),
          upstreamId: upstream._id,
          usage: sniffed.usage,
          completionChars: sniffed.completionChars,
          stream: true,
        });
      },
    }),
  );

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function absorbEvent(
  event: IrEvent,
  sniffed: { usage: IrUsage | null; completionChars: number },
): void {
  if (event.type === "text") {
    sniffed.completionChars += event.text.length;
  } else if (event.type === "usage") {
    sniffed.usage = event.usage;
  }
}

export interface RelayOptions {
  /** 客户端请求使用的协议。 */
  format: ApiFormat;
  request: Request;
}

/**
 * /v1 代理入口：认证 → 额度 → 解码请求 → 上游故障转移 → 编码响应。
 * 返回 `NextResponse`（错误）或 `Response`（成功）。
 */
export async function relayCompletion({ format, request }: RelayOptions): Promise<Response> {
  const user = await authenticateAiKey(request);
  if (!user) {
    return clientError(format, "Invalid API key.", 401, "authentication_error");
  }

  const body = await request.json().catch(() => null);
  let ir: IrRequest;
  try {
    ir = decodeClientRequest(format, body);
  } catch (error) {
    return clientError(
      format,
      error instanceof Error ? error.message : "Invalid request.",
      400,
      "invalid_request_error",
    );
  }

  const quota = await getUserQuotaState(user.id);
  if (!quota.available) {
    return clientError(
      format,
      quota.reason === "expired"
        ? "Your plan has expired. Redeem a new card key to continue."
        : "Insufficient quota. Redeem a card key to top up.",
      402,
      "insufficient_quota",
    );
  }

  const upstreams = await listUpstreamsForModel(ir.model);
  if (upstreams.length === 0) {
    return clientError(format, `Model '${ir.model}' has no available upstream.`, 404, "model_not_found");
  }

  const defaults = await getModelDefaults();
  const settle: SettleParams = {
    userId: user.id,
    modelId: ir.model,
    promptTokens: estimateIrPromptTokens(ir),
    defaults: { contextSizes: defaults.contextSizes, rates: defaults.rates },
  };

  if (ir.stream) {
    return streamProxy(format, ir, upstreams, settle);
  }
  return nonStreamProxy(format, ir, upstreams, settle);
}
