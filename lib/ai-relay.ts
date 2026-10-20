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
import { type BaseModelContext, resolveModelRates } from "@/lib/model-rates";
import { computeCost } from "@/lib/quota";
import { consumeQuota, getModelRateSettings, getUserQuotaState, listUpstreamsForModel, recordUsage } from "@/lib/storage";
import type { UpstreamDoc } from "@/lib/types";
import { createLogger } from "@/lib/runtime-logs";

export const UPSTREAM_TIMEOUT_MS = 120_000;

/** AI 中继业务事件日志器（source="relay"）。 */
const relayLog = createLogger("relay");

interface ModelDefaults {
  rates: Record<string, { input: number; output: number; cacheRead: number }>;
}

interface SettleParams {
  userId: string;
  modelId: string;
  promptTokens: number;
  defaults: ModelDefaults;
  /** 1x 基准上下文；无基准（baseModelId = null）= models.dev 归一化口径。 */
  base: BaseModelContext | null;
}

/**
 * 元数据解析（按模型）：modelMeta.override 开启时使用其自定义值（缺失
 * 字段回退 models.dev），否则直接使用 models.dev 元数据；倍率无数据时
 * 默认 1x（显式配置 0 = 不计费）。最终实际倍率再乘以模型整体倍率
 * modelRate（modelMeta[model].multiplier）与上游整体倍率 providerRate
 * （upstream.multiplier）：实际倍率 = tokenTypeRate × modelRate × providerRate。
 * 设了 1x 基准模型时基准模型自身恒为 1x。缓存读取倍率按配置原样生效。
 */
function resolveModelMeta(upstream: UpstreamDoc, model: string, defaults: ModelDefaults, base: BaseModelContext | null) {
  return resolveModelRates(upstream, model, defaults.rates, base);
}

/**
 * 请求完成后按 usage 扣减额度并记录用量。usage 缺失时按完成文本的
 * 字符长度估算 completion tokens。失败只记日志，不影响响应送达。
 *
 * 记账口径：`usage_logs.promptTokens` 只记未命中缓存的输入 token，
 * 缓存读取 token 单独记在 `cachedTokens`；`totalTokens` 仍是完整用量
 * （未缓存输入 + 缓存读取 + 输出），供趋势图与汇总统计使用。
 */
async function settleUsage(
  params: SettleParams & {
    inputRate: number;
    outputRate: number;
    cacheReadRate: number;
    upstreamId: string | null;
    usage: IrUsage | null;
    completionChars: number;
    /** 请求耗时（毫秒，从上游请求开始到 usage 结算）。 */
    durationMs: number;
  },
): Promise<void> {
  const usage = params.usage;
  const completionTokens = usage?.completionTokens ?? Math.ceil(params.completionChars / 4);
  const promptTokens = usage?.promptTokens ?? params.promptTokens;
  // 上游的 prompt tokens 含缓存命中部分；缓存量不会超过提示总量。
  const cachedTokens = Math.min(usage?.cachedTokens ?? 0, promptTokens);
  const uncachedTokens = promptTokens - cachedTokens;
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  const cost = computeCost(
    promptTokens,
    completionTokens,
    params.inputRate,
    params.outputRate,
    cachedTokens,
    params.cacheReadRate,
  );
  try {
    await consumeQuota(params.userId, cost);
    await recordUsage({
      userId: params.userId,
      modelId: params.modelId,
      upstreamId: params.upstreamId,
      promptTokens: uncachedTokens,
      completionTokens,
      cachedTokens,
      totalTokens,
      cost,
      durationMs: params.durationMs,
    });
    relayLog.info("Usage settled.", { userId: params.userId, modelId: params.modelId, upstreamId: params.upstreamId, promptTokens: uncachedTokens, completionTokens, cachedTokens, totalTokens, cost, durationMs: params.durationMs });
  } catch (error) {
    relayLog.error("Unable to settle usage after completion.", { userId: params.userId, modelId: params.modelId, upstreamId: params.upstreamId, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error });
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

/** 记入日志的上游错误体截断长度：足够定位，又不至于把整页 HTML 写进日志。 */
const UPSTREAM_ERROR_EXCERPT_LIMIT = 512;

/**
 * 一次上游尝试的失败记录。`status === null` = 没拿到响应（连接失败/超时）。
 *
 * `retryable` 判定的是「换下一个上游有没有可能成功」，不是「谁的责任」：
 * 上游用 4xx 表达自身的模型/账号/转码故障（如 `tool calls and tool results
 * do not match`、`Model … is not supported by any configured account`），
 * 这类必须故障转移；只有 413/415 是载荷本身不可处理、换上游也没用。
 */
interface UpstreamFailure {
  upstreamId: string;
  upstreamFormat: ApiFormat;
  status: number | null;
  message: string;
  raw: string;
  contentType: string | null;
  retryable: boolean;
}

/** 与上游无关、换上游也不会成功的 4xx（请求体不可处理）。 */
const NON_RETRYABLE_STATUS: Record<number, true> = { 413: true, 415: true };

/** 描述「请求体不合法」的 4xx：全部上游一致时回传给调用方，否则归为网关故障。 */
const PAYLOAD_ERROR_STATUS: Record<number, true> = { 400: true, 422: true };

/** 从 OpenAI / Anthropic / Gemini 三种错误体形状里取可读 message。 */
function upstreamErrorMessage(raw: string, status: number): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // 非 JSON 错误体按原文返回。
  }
  return raw.trim() || `Upstream returned ${status}.`;
}

/** 把一次失败的上游响应完整读入失败记录（读掉 body，避免连接悬挂）。 */
async function recordUpstreamFailure(
  response: Response,
  upstream: UpstreamDoc,
  upstreamFormat: ApiFormat,
): Promise<UpstreamFailure> {
  const raw = await response.text().catch(() => "");
  return {
    upstreamId: upstream._id,
    upstreamFormat,
    status: response.status,
    message: upstreamErrorMessage(raw, response.status),
    raw,
    contentType: response.headers.get("content-type"),
    retryable: response.status >= 500 || NON_RETRYABLE_STATUS[response.status] !== true,
  };
}

/** 上游错误体转换为客户端格式，保留上游 message 与状态码。 */
function upstreamFailureResponse(failure: UpstreamFailure, clientFormat: ApiFormat): Response {
  const status = failure.status ?? 502;
  if (clientFormat === failure.upstreamFormat) {
    return new Response(failure.raw || JSON.stringify(formatErrorBody(clientFormat, failure.message)), {
      status,
      headers: { "content-type": failure.contentType ?? "application/json" },
    });
  }
  return NextResponse.json(formatErrorBody(clientFormat, failure.message, "upstream_error"), { status });
}

function upstreamRequestBody(upstreamFormat: ApiFormat, ir: IrRequest): Record<string, unknown> {
  const body = encodeUpstreamRequest(upstreamFormat, ir);
  if (ir.stream && upstreamFormat === "chat") {
    // 强制上游返回 usage；不支持该扩展的上游会忽略它，由增量文本兜底估算。
    body.stream_options = { include_usage: true };
  }
  return body;
}

/**
 * 所有上游都用尽时的响应。逐条记录每个上游的失败原因（状态码 + 上游原文
 * 摘要），并让调用方看到真实原因而不是一律 `Upstream model service is
 * unavailable`：
 *
 * - 全部尝试都以同一个 4xx 收场 → 原样返回该状态码与上游 message（典型：
 *   `tool calls and tool results do not match`、模型不被上游支持）；
 * - 其余（连接失败、5xx、4xx 混合）→ 502，消息里带上逐条摘要。
 */
function exhaustedResponse(
  clientFormat: ApiFormat,
  ir: IrRequest,
  upstreams: UpstreamDoc[],
  failures: UpstreamFailure[],
  stream: boolean,
): Response {
  const summary = failures.map((failure, index) => {
    const status = failure.status === null ? "no response" : String(failure.status);
    return `[${index + 1}] ${failure.upstreamFormat} ${status}: ${failure.message.slice(0, 200)}`;
  });
  relayLog.error("All upstreams exhausted.", {
    modelId: ir.model,
    stream,
    attempts: failures.map((failure) => ({
      upstreamId: failure.upstreamId,
      upstreamFormat: failure.upstreamFormat,
      status: failure.status,
      message: failure.message,
      body: failure.raw.slice(0, UPSTREAM_ERROR_EXCERPT_LIMIT),
    })),
  });

  const statuses = failures.map((failure) => failure.status);
  // 只回传「上游认为请求体本身不合法」的状态码：401/402/403/429 是上游自己的
  // 密钥或限流问题，回传给调用方会被误解为「你的 key 无效 / 额度不足」。
  const agreedStatus =
    statuses.length > 0 &&
    statuses.every((status) => status !== null && PAYLOAD_ERROR_STATUS[status] === true && status === statuses[0])
      ? statuses[0]
      : null;
  if (agreedStatus !== null) {
    return clientError(clientFormat, failures[0].message, agreedStatus, "invalid_request_error");
  }
  return clientError(
    clientFormat,
    `Upstream model service is unavailable (${upstreams.length} upstream${upstreams.length === 1 ? "" : "s"} tried). ${summary.join("; ")}`,
    502,
    "api_error",
  );
}

async function nonStreamProxy(
  clientFormat: ApiFormat,
  ir: IrRequest,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
): Promise<Response> {
  const failures: UpstreamFailure[] = [];
  for (const upstream of upstreams) {
    const upstreamFormat = resolveUpstreamFormat(upstream, clientFormat);
    let response: Response;
    const startedAt = Date.now();
    try {
      response = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}${formatPath(upstreamFormat)}`, {
        method: "POST",
        headers: upstreamHeaders(upstreamFormat, upstream.apiKey),
        body: JSON.stringify(upstreamRequestBody(upstreamFormat, { ...ir, stream: false })),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ upstreamId: upstream._id, upstreamFormat, status: null, message, raw: "", contentType: null, retryable: true });
      relayLog.warn("Upstream request failed.", { userId: settle.userId, modelId: settle.modelId, upstreamId: upstream._id, upstreamFormat, error: error instanceof Error ? { name: error.name, message: error.message } : error });
      continue;
    }

    if (!response.ok) {
      const failure = await recordUpstreamFailure(response, upstream, upstreamFormat);
      failures.push(failure);
      relayLog.warn(failure.retryable ? "Upstream error, failing over." : "Upstream error, not retryable, passing through.", {
        userId: settle.userId,
        modelId: settle.modelId,
        upstreamId: upstream._id,
        upstreamFormat,
        status: failure.status,
        message: failure.message,
        body: failure.raw.slice(0, UPSTREAM_ERROR_EXCERPT_LIMIT),
        remainingUpstreams: upstreams.length - failures.length,
      });
      if (failure.retryable) continue;
      return upstreamFailureResponse(failure, clientFormat);
    }

    const payload = await response.json().catch(() => null);
    if (!payload) {
      failures.push({ upstreamId: upstream._id, upstreamFormat, status: response.status, message: "Unreadable JSON response body.", raw: "", contentType: response.headers.get("content-type"), retryable: true });
      relayLog.warn("Upstream response body is not JSON, failing over.", { userId: settle.userId, modelId: settle.modelId, upstreamId: upstream._id, upstreamFormat, status: response.status });
      continue;
    }

    const decoded = decodeUpstreamResponse(upstreamFormat, payload);
    decoded.finishReason = normalizeFinishReason(decoded.finishReason);
    await settleUsage({
      ...settle,
      ...resolveModelMeta(upstream, settle.modelId, settle.defaults, settle.base),
      upstreamId: upstream._id,
      usage: decoded.usage,
      completionChars: decoded.text.length,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(encodeClientResponse(clientFormat, decoded, ir.model), {
      status: response.status,
    });
  }

  return exhaustedResponse(clientFormat, ir, upstreams, failures, false);
}

async function streamProxy(
  clientFormat: ApiFormat,
  ir: IrRequest,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
): Promise<Response> {
  const failures: UpstreamFailure[] = [];
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
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ upstreamId: upstream._id, upstreamFormat, status: null, message, raw: "", contentType: null, retryable: true });
      relayLog.warn("Upstream stream request failed.", { userId: settle.userId, modelId: settle.modelId, upstreamId: upstream._id, upstreamFormat, error: error instanceof Error ? { name: error.name, message: error.message } : error });
      continue;
    }
    if (!response.ok) {
      const failure = await recordUpstreamFailure(response, upstream, upstreamFormat);
      failures.push(failure);
      relayLog.warn(failure.retryable ? "Upstream stream error, failing over." : "Upstream stream error, not retryable, passing through.", {
        userId: settle.userId,
        modelId: settle.modelId,
        upstreamId: upstream._id,
        upstreamFormat,
        status: failure.status,
        message: failure.message,
        body: failure.raw.slice(0, UPSTREAM_ERROR_EXCERPT_LIMIT),
        remainingUpstreams: upstreams.length - failures.length,
      });
      if (failure.retryable) continue;
      return upstreamFailureResponse(failure, clientFormat);
    }
    if (!response.body) {
      failures.push({ upstreamId: upstream._id, upstreamFormat, status: response.status, message: "Stream response has no body.", raw: "", contentType: null, retryable: true });
      relayLog.warn("Upstream stream response has no body, failing over.", { userId: settle.userId, modelId: settle.modelId, upstreamId: upstream._id, upstreamFormat });
      continue;
    }
    return buildStreamingResponse(clientFormat, upstreamFormat, response, upstream, ir.model, settle);
  }

  return exhaustedResponse(clientFormat, ir, upstreams, failures, true);
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
  const startedAt = Date.now();
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
          ...resolveModelMeta(upstream, settle.modelId, settle.defaults, settle.base),
          upstreamId: upstream._id,
          usage: sniffed.usage,
          completionChars: sniffed.completionChars,
          durationMs: Date.now() - startedAt,
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
    relayLog.warn("AI key authentication failed.", { format, reason: "invalid-api-key" });
    return clientError(format, "Invalid API key.", 401, "authentication_error");
  }

  const body = await request.json().catch(() => null);
  let ir: IrRequest;
  try {
    ir = decodeClientRequest(format, body);
  } catch (error) {
    relayLog.warn("Request decode failed.", { userId: user.id, format, reason: error instanceof Error ? error.message : "decode-error" });
    return clientError(
      format,
      error instanceof Error ? error.message : "Invalid request.",
      400,
      "invalid_request_error",
    );
  }

  const quota = await getUserQuotaState(user.id);
  if (!quota.available) {
    relayLog.warn("Quota unavailable.", { userId: user.id, modelId: ir.model, stream: ir.stream, reason: quota.reason });
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
    relayLog.warn("No upstream available for model.", { userId: user.id, modelId: ir.model, stream: ir.stream });
    return clientError(format, `Model '${ir.model}' has no available upstream.`, 404, "model_not_found");
  }

  relayLog.info("Relay request started.", { userId: user.id, modelId: ir.model, stream: ir.stream, upstreamCount: upstreams.length, promptTokens: estimateIrPromptTokens(ir) });

  const defaults = await getModelDefaults();
  const settings = await getModelRateSettings();
  const baseModelId = settings.baseModelId;
  const base: BaseModelContext | null =
    baseModelId !== null && defaults.rates[baseModelId] !== undefined ? { modelId: baseModelId } : null;
  const settle: SettleParams = {
    userId: user.id,
    modelId: ir.model,
    promptTokens: estimateIrPromptTokens(ir),
    defaults: { rates: defaults.rates },
    base,
  };

  if (ir.stream) {
    return streamProxy(format, ir, upstreams, settle);
  }
  return nonStreamProxy(format, ir, upstreams, settle);
}
