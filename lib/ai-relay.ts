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
 *
 * 上游协议为 `auto`（跟随客户端）时不做 IR 往返：客户端请求体与上游
 * 响应/SSE 字节原样转发，服务端只旁路解析 `data:` 载荷以嗅探 `usage`
 * 用于计费（上游未报 usage 时按字符长度估算）。请求体一个字节都不改，
 * 因此 `response_format`、`stop`、`seed`、`tool_choice`、`stream_options`
 * 等 IR 不承载的参数全部原样到达上游。
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

/**
 * /v1 路由的执行预算（秒）。路由必须写**字面量**
 * `export const maxDuration = 120 satisfies typeof RELAY_MAX_DURATION_SECONDS`，
 * 否则平台会在上游超时之前杀掉函数：客户端拿到无响应、用量也不会结算。
 *
 * 不能写成 `= RELAY_MAX_DURATION_SECONDS`：Next 静态解析 segment config，
 * 标识符会报 Unknown identifier 并让 `next build` 以 1 退出。`satisfies`
 * 让 typecheck 在常量漂移时失败。
 */
export const RELAY_MAX_DURATION_SECONDS = 120;

/** 上游单次尝试的超时；留出 5 秒给结算与响应收尾。 */
export const UPSTREAM_TIMEOUT_MS = (RELAY_MAX_DURATION_SECONDS - 5) * 1000;

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
    /** 上游报告的用量；undefined = 上游未提供，按文本长度估算。 */
    usage: IrUsage | null | undefined;
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
    // 成功记账不写 runtime_logs：usage_logs 已经保存了同一份数据，逐请求
    // 再插一行只会让日志表无谓膨胀（失败路径仍然记 error）。
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

/** 上游错误体的保留长度（字节）：错误响应只需要可读摘要，不应让上游用
 *  巨型 body 逼本实例分配任意大小的内存。 */
const UPSTREAM_ERROR_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * 读入上游错误体，最多保留 [UPSTREAM_ERROR_BODY_LIMIT_BYTES]。
 *
 * 必须流式读取：`response.text()` 会先把整个 body 拉进内存，之后再截断
 * 已经没有意义（一个 1 GiB 的错误页就能打爆实例）。读满上限后取消剩余
 * 读取，同时保证连接被正常释放而不是悬挂。
 */
async function readUpstreamErrorBody(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      const remaining = UPSTREAM_ERROR_BODY_LIMIT_BYTES - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // 上游中途断开：保留已读到的部分。
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** 把一次失败的上游响应读入失败记录（读掉 body，避免连接悬挂）。 */
async function recordUpstreamFailure(
  response: Response,
  upstream: UpstreamDoc,
  upstreamFormat: ApiFormat,
): Promise<UpstreamFailure> {
  const raw = await readUpstreamErrorBody(response);
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
      headers: {
        "content-type": failure.contentType ?? "application/json",
        "x-content-type-options": "nosniff",
      },
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
 * 直通响应的头：照抄上游，但剔除逐跳头与长度/编码头 —— `fetch` 已经解码
 * `content-encoding` 并重新分块，照抄会让客户端按错误长度或错误的压缩
 * 声明去读 body。
 */
const HOP_BY_HOP_HEADERS: Record<string, true> = {
  connection: true,
  "keep-alive": true,
  "transfer-encoding": true,
  "content-encoding": true,
  "content-length": true,
  upgrade: true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  // 上游不得借直通给本域写 cookie。
  "set-cookie": true,
};

function forwardedResponseHeaders(response: Response, streaming: boolean): Headers {
  const headers = new Headers();
  response.headers.forEach((value, name) => {
    if (HOP_BY_HOP_HEADERS[name.toLowerCase()] !== true) {
      headers.set(name, value);
    }
  });
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("content-type")) {
    headers.set("content-type", streaming ? "text/event-stream; charset=utf-8" : "application/json");
  }
  if (streaming) {
    headers.set("cache-control", "no-cache");
    // 反向代理不得缓冲 SSE（否则流式响应会攒到结束才吐出）。
    headers.set("x-accel-buffering", "no");
  }
  return headers;
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
  clientBody: string,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
  clientSignal: AbortSignal,
): Promise<Response> {
  const failures: UpstreamFailure[] = [];
  for (const upstream of upstreams) {
    // `auto` = 跟随客户端：请求体与响应体都按客户端协议原样转发。
    const passThrough = (upstream.apiFormat ?? "auto") === "auto";
    const upstreamFormat = resolveUpstreamFormat(upstream, clientFormat);
    let response: Response;
    const startedAt = Date.now();
    try {
      response = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}${formatPath(upstreamFormat)}`, {
        method: "POST",
        headers: upstreamHeaders(upstreamFormat, upstream.apiKey),
        body: passThrough
          ? clientBody
          : JSON.stringify(upstreamRequestBody(upstreamFormat, { ...ir, stream: false })),
        // 客户端断连时立即放弃上游请求，不再为无人接收的结果付费。
        signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), clientSignal]),
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

    // 直通必须读完整 body 才能取到 usage；读到的原文随后原样回传。
    const raw = passThrough ? await response.text() : null;
    let payload: unknown = null;
    if (passThrough) {
      try {
        payload = JSON.parse(raw!);
      } catch {
        payload = null;
      }
    } else {
      payload = await response.json().catch(() => null);
    }
    if (payload === null) {
      failures.push({ upstreamId: upstream._id, upstreamFormat, status: response.status, message: "Unreadable JSON response body.", raw: raw ?? "", contentType: response.headers.get("content-type"), retryable: true });
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
    if (passThrough) {
      return new Response(raw, { status: response.status, headers: forwardedResponseHeaders(response, false) });
    }
    return NextResponse.json(encodeClientResponse(clientFormat, decoded, ir.model), {
      status: response.status,
    });
  }

  return exhaustedResponse(clientFormat, ir, upstreams, failures, false);
}

async function streamProxy(
  clientFormat: ApiFormat,
  ir: IrRequest,
  clientBody: string,
  upstreams: UpstreamDoc[],
  settle: SettleParams,
  clientSignal: AbortSignal,
): Promise<Response> {
  const failures: UpstreamFailure[] = [];
  for (const upstream of upstreams) {
    // `auto` = 跟随客户端：请求体与 SSE 字节都原样转发，仅旁路嗅探 usage。
    const passThrough = (upstream.apiFormat ?? "auto") === "auto";
    const upstreamFormat = resolveUpstreamFormat(upstream, clientFormat);
    let response: Response;
    try {
      response = await fetch(`${upstream.baseUrl.replace(/\/+$/, "")}${formatPath(upstreamFormat)}`, {
        method: "POST",
        headers: upstreamHeaders(upstreamFormat, upstream.apiKey),
        body: passThrough
          ? clientBody
          : JSON.stringify(upstreamRequestBody(upstreamFormat, { ...ir, stream: true })),
        // 响应头到达后 body 由 buildStreamingResponse 的 cancel() 负责中止，
        // 这里的 signal 覆盖「还没拿到响应头就断连」的窗口。
        signal: AbortSignal.any([AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), clientSignal]),
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
    if (passThrough) {
      return buildPassThroughStreamingResponse(upstreamFormat, response, upstream, settle);
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
    /** 上游给出过终止信号（finish_reason / message_stop / response.completed / [DONE]）。 */
    sawTerminal: false,
  };
  let settled = false;

  // 结算必须恰好发生一次：正常结束走 flush（await，保证 serverless 实例
  // 在函数返回前写完额度），客户端断连走 cancel（无响应可等，只能尽力）。
  const settleOnce = (): Promise<void> | null => {
    if (settled) {
      return null;
    }
    settled = true;
    return settleUsage({
      ...settle,
      ...resolveModelMeta(upstream, settle.modelId, settle.defaults, settle.base),
      upstreamId: upstream._id,
      usage: sniffed.usage,
      completionChars: sniffed.completionChars,
      durationMs: Date.now() - startedAt,
    });
  };

  // Deltas go out as they arrive; the terminal event waits for the stream's
  // end so it can carry the usage chunk that providers send last.
  const emit = (event: IrEvent, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (event.type === "finish") {
      sniffed.finishReason = event.reason;
      sniffed.sawTerminal = true;
      return;
    }
    if (event.type === "error") {
      sniffed.sawTerminal = true;
    }
    absorbEvent(event, sniffed);
    const out = encoder.push(event);
    if (out) controller.enqueue(textEncoder.encode(out));
  };

  const handlePayload = (payload: string, controller: TransformStreamDefaultController<Uint8Array>) => {
    if (payload === "[DONE]") {
      sniffed.sawTerminal = true;
      return;
    }
    for (const event of decoder.feed(payload)) emit(event, controller);
  };

  const transformed = response.body!.pipeThrough(
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
        // 先取快照：decoder.finish() 会补一个 finish 事件，那会把
        // sawTerminal 置真，从而掩盖「上游根本没给终止信号」。
        const terminated = sniffed.sawTerminal;
        for (const event of decoder.finish()) emit(event, controller);
        // 上游在没有任何终止信号的情况下断开（连接被掐、超时、网关截断）：
        // 绝不能补一个 finish_reason=stop 冒充正常完成。
        if (!terminated) {
          relayLog.warn("Upstream stream ended without a terminal event.", {
            userId: settle.userId,
            modelId: settle.modelId,
            upstreamId: upstream._id,
            upstreamFormat,
            completionChars: sniffed.completionChars,
          });
          const failure = encoder.push({
            type: "error",
            message: "Upstream stream ended unexpectedly.",
          });
          if (failure) controller.enqueue(textEncoder.encode(failure));
        }
        const terminal = encoder.push({ type: "finish", reason: sniffed.finishReason });
        if (terminal) controller.enqueue(textEncoder.encode(terminal));
        const closing = encoder.end();
        if (closing) controller.enqueue(textEncoder.encode(closing));
        await settleOnce();
      },
    }),
  );

  // Transformer 没有 cancel 钩子（取消时 flush 不会执行）。用一个显式的
  // ReadableStream 包住转换结果，才能在客户端断连时中止上游并结算。
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = transformed.getReader();
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader!.read();
            if (cancelled) {
              return;
            }
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (error) {
          // 取消后 controller 已失效，再 error() 会抛二次异常。
          if (!cancelled) {
            controller.error(error);
          }
        }
      };
      void pump();
    },
    cancel(reason) {
      // 客户端断连：停止读取上游（释放连接与上游生成成本），并按已产生
      // 的内容结算，避免「中断即免费」。
      cancelled = true;
      void reader?.cancel(reason).catch(() => undefined);
      void settleOnce();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // 反向代理不得缓冲 SSE（否则流式响应会攒到结束才吐出）。
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
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

/**
 * 直通模式的流式响应：上游 SSE 字节原样转发，只在旁边解析 `data:` 载荷
 * 嗅探 usage 与完成文本长度用于计费。不重新编码、不补事件、不改终止符 ——
 * 客户端看到的与直连上游完全一致。
 */
function buildPassThroughStreamingResponse(
  upstreamFormat: ApiFormat,
  response: Response,
  upstream: UpstreamDoc,
  settle: SettleParams,
): Response {
  const decoder = createStreamDecoder(upstreamFormat);
  const textDecoder = new TextDecoder();
  const startedAt = Date.now();
  const sniffed = { usage: null as IrUsage | null, completionChars: 0 };
  let buffer = "";
  let sawDataLine = false;
  let settled = false;

  const settleOnce = (): Promise<void> | null => {
    if (settled) {
      return null;
    }
    settled = true;
    return settleUsage({
      ...settle,
      ...resolveModelMeta(upstream, settle.modelId, settle.defaults, settle.base),
      upstreamId: upstream._id,
      usage: sniffed.usage,
      completionChars: sniffed.completionChars,
      durationMs: Date.now() - startedAt,
    });
  };

  const sniffPayload = (payload: string) => {
    if (payload === "[DONE]") {
      return;
    }
    for (const event of decoder.feed(payload)) absorbEvent(event, sniffed);
  };

  const transformed = response.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // 先原样转发，再解析副本：嗅探失败绝不能影响客户端收到的字节。
        controller.enqueue(chunk);
        buffer += textDecoder.decode(chunk, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) {
            continue;
          }
          sawDataLine = true;
          const payload = trimmed.slice(5).trim();
          if (payload) sniffPayload(payload);
        }
      },
      async flush() {
        const trailing = buffer.trim();
        if (trailing.startsWith("data:")) {
          sawDataLine = true;
          const payload = trailing.slice(5).trim();
          if (payload) sniffPayload(payload);
        } else if (!sawDataLine && trailing) {
          // 上游对 stream 请求回了单行 JSON：按普通响应嗅探 usage。
          try {
            const decoded = decodeUpstreamResponse(upstreamFormat, JSON.parse(trailing));
            sniffed.usage = decoded.usage ?? null;
            sniffed.completionChars = decoded.text.length;
          } catch {
            // 非 JSON 的尾部内容按原样转发，计费退化为按提示词估算。
          }
        }
        for (const event of decoder.finish()) absorbEvent(event, sniffed);
        await settleOnce();
      },
    }),
  );

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      reader = transformed.getReader();
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader!.read();
            if (cancelled) {
              return;
            }
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (error) {
          if (!cancelled) {
            controller.error(error);
          }
        }
      };
      void pump();
    },
    cancel(reason) {
      // 客户端断连：停止读取上游，并按已转发的内容结算。
      cancelled = true;
      void reader?.cancel(reason).catch(() => undefined);
      void settleOnce();
    },
  });

  return new Response(stream, {
    status: response.status,
    headers: forwardedResponseHeaders(response, true),
  });
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

  const rawBody = await request.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = null;
  }
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

  // 四个独立读取并行：额度、上游列表、models.dev 元数据、基准设置互不依赖，
  // 串行会让每次对话多付约 3 个 RTT。
  const [quota, upstreams, defaults, settings] = await Promise.all([
    getUserQuotaState(user.id),
    listUpstreamsForModel(ir.model),
    getModelDefaults(),
    getModelRateSettings(),
  ]);
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
  if (upstreams.length === 0) {
    relayLog.warn("No upstream available for model.", { userId: user.id, modelId: ir.model, stream: ir.stream });
    return clientError(format, `Model '${ir.model}' has no available upstream.`, 404, "model_not_found");
  }

  const baseModelId = settings.baseModelId;
  const base: BaseModelContext | null =
    baseModelId !== null && defaults.rates[baseModelId] !== undefined ? { modelId: baseModelId } : null;
  // 提示词估算要遍历全部消息与工具定义，只算一次。
  const promptTokens = estimateIrPromptTokens(ir);
  const settle: SettleParams = {
    userId: user.id,
    modelId: ir.model,
    promptTokens,
    defaults: { rates: defaults.rates },
    base,
  };

  if (ir.stream) {
    return streamProxy(format, ir, rawBody, upstreams, settle, request.signal);
  }
  return nonStreamProxy(format, ir, rawBody, upstreams, settle, request.signal);
}
