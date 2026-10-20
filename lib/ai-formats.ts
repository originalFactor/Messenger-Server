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
 * 四种对话 API 之间的无损（尽力）转换层。
 *
 * 支持的线格式：
 *  - `chat`         OpenAI Chat Completions（/chat/completions）
 *  - `responses`    OpenAI Responses（/responses）
 *  - `messages`     Anthropic Messages（/messages）
 *  - `interactions` Gemini Interactions（/interactions）
 *
 * 所有请求先解码为内部 IR（[IrRequest]），再按上游格式编码；上游响应/SSE
 * 先解码为 IR（[IrResponse] / [IrEvent]），再按客户端格式编码。模块本身零依赖，
 * 便于脱离 Next 运行时做单元验证。
 *
 * 不转换的内容（按设计丢弃）：音频/视频块、引用标注、加密思维链签名、
 * 平台专有工具（web search / maps / file search）。文本、图片、函数调用、
 * 推理文本与 usage 均双向映射。
 */

export type ApiFormat = "chat" | "responses" | "messages" | "interactions";

export const API_FORMATS: readonly ApiFormat[] = ["chat", "responses", "messages", "interactions"];

/** 上游可选的格式：四种之一，或 `auto` = 跟随客户端请求格式。 */
export type UpstreamApiFormat = ApiFormat | "auto";

export function normalizeApiFormat(value: unknown, fallback: ApiFormat = "chat"): ApiFormat {
  return typeof value === "string" && (API_FORMATS as readonly string[]).includes(value)
    ? (value as ApiFormat)
    : fallback;
}

export function normalizeUpstreamApiFormat(value: unknown): UpstreamApiFormat {
  if (value === "auto") return "auto";
  return normalizeApiFormat(value, "chat");
}

/** 上游/客户端的请求路径（base URL 已含版本段，例如 /v1 或 /v1beta）。 */
export function formatPath(format: ApiFormat): string {
  switch (format) {
    case "responses":
      return "/responses";
    case "messages":
      return "/messages";
    case "interactions":
      return "/interactions";
    default:
      return "/chat/completions";
  }
}

/** 模型列表路径：四种协议都在 `<base>/models` 下。 */
export const MODELS_PATH = "/models";

/**
 * 上游认证头。Anthropic 用 `x-api-key` + `anthropic-version`，Gemini 用
 * `x-goog-api-key`；同时保留 `Authorization: Bearer`，让兼容网关（以及
 * 本服务自己的 /v1 代理）也能直接使用。
 */
export function upstreamHeaders(format: ApiFormat, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (format === "messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (format === "interactions") {
    headers["x-goog-api-key"] = apiKey;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// IR
// ---------------------------------------------------------------------------

export type IrPart =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; callId: string; name?: string; output: string; isError?: boolean };

export interface IrMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: IrPart[];
}

export interface IrTool {
  name: string;
  description: string;
  parameters: unknown;
}

export interface IrRequest {
  model: string;
  messages: IrMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  tools?: IrTool[];
  stream: boolean;
}

export interface IrUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface IrToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface IrResponse {
  text: string;
  reasoning?: string;
  toolCalls: IrToolCall[];
  /**
   * 上游报告的用量；上游未提供 usage 块时为 undefined。必须区分「没有」
   * 与「全 0」：计费在缺失时要按文本长度估算，全 0 会被当成真实用量
   * 从而只扣 1 token。
   */
  usage?: IrUsage;
  finishReason: string;
}

export type IrEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "usage"; usage: IrUsage }
  | { type: "finish"; reason: string }
  | { type: "error"; message: string };

export class FormatError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = asRecord(part);
        if (!record) return "";
        const text = str(record.text) ?? str(record.content);
        return text ?? "";
      })
      .join("");
  }
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/**
 * 工具调用配对簿：登记尚未收到结果的调用，并保证两侧解析出同一个键。
 *
 * 只有 Chat Completions 把调用与结果分别放在 `tool_calls` 和 `tool_call_id`
 * 上；Responses / Interactions 是平铺的兄弟条目，Anthropic 则是同一回合里
 * 的 block。配对键缺失时（旧客户端、其他网关转发的历史）不能退化成空串 ——
 * 空串必然让上游判定 `tool calls and tool results do not match`。这里按
 * 到达顺序认领未完成的调用；完全没有结果的调用在收尾时补一条显式的
 * 「未返回」失败结果，使 call 与 result 的键集合始终相等。
 */
class ToolCallLedger {
  /** 待配对调用：`keys[0]` 是写入历史的键，其余是同一条调用的别名。 */
  private readonly pending: { keys: string[] }[] = [];
  private synthetic = 0;

  /** 登记一次调用，返回其配对键（无自带键时按到达顺序自造）。 */
  open(id: string | undefined, ...aliases: (string | undefined)[]): string {
    const callId = id ?? `call_synth_${this.synthetic}`;
    this.synthetic += 1;
    const keys = [callId, ...aliases.filter((alias): alias is string => alias !== undefined && alias !== callId)];
    this.pending.push({ keys });
    return callId;
  }

  /**
   * 认领一次结果：键匹配任一别名即命中；键缺失按 FIFO 认领最早的调用。
   * 返回 undefined = 没有可配对的调用（结果无主，调用方应丢弃它）。
   */
  settle(id: string | undefined): string | undefined {
    const index =
      id === undefined ? 0 : this.pending.findIndex((entry) => entry.keys.includes(id));
    if (index === -1) return undefined;
    return this.pending.splice(index, 1)[0]?.keys[0];
  }

  /**
   * 为从未收到结果的调用补一条错误结果，插在该 assistant 回合之后。
   * 结果文本明确说明工具未返回，不伪造任何工具输出。
   */
  reconcile(messages: IrMessage[]): void {
    if (this.pending.length === 0) return;
    const unanswered = new Set(this.pending.map((entry) => entry.keys[0]));
    for (let index = 0; index < messages.length && unanswered.size > 0; index += 1) {
      const message = messages[index];
      if (message.role !== "assistant") continue;
      const results: IrPart[] = [];
      for (const part of message.parts) {
        if (part.type !== "tool_call" || !unanswered.delete(part.id)) continue;
        results.push({
          type: "tool_result",
          callId: part.id,
          output: "The tool call did not return a result.",
          isError: true,
        });
      }
      if (results.length > 0) {
        messages.splice(index + 1, 0, { role: "tool", parts: results });
        index += 1;
      }
    }
    this.pending.length = 0;
  }
}

function parseDataUri(uri: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri);
  if (!match) return null;
  const mediaType = match[1] || "application/octet-stream";
  if (match[2]) {
    return { mediaType, data: match[3] ?? "" };
  }
  // 非 base64 的 data URI：按 UTF-8 文本重新编码（图片几乎不会走这条）。
  const data = typeof Buffer !== "undefined"
    ? Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8").toString("base64")
    : match[3] ?? "";
  return { mediaType, data };
}

export function normalizeFinishReason(reason: string | undefined | null): string {
  switch (reason) {
    case "max_tokens":
    case "length":
      return "length";
    case "tool_use":
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
    case "safety":
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop":
    case "stop_sequence":
    case "completed":
      return "stop";
    case undefined:
    case null:
    case "":
      return "stop";
    default:
      return reason;
  }
}

/** 把 `reasoning_effort` 归一到 Interactions 的 thinking_level。 */
function thinkingLevel(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  switch (effort) {
    case "none":
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// inbound request decoding (client format → IR)
// ---------------------------------------------------------------------------

export function decodeClientRequest(format: ApiFormat, body: unknown): IrRequest {
  const record = asRecord(body);
  if (!record) {
    throw new FormatError("Request body must be a JSON object.");
  }
  const model = str(record.model);
  if (!model) {
    throw new FormatError("'model' is required.");
  }
  switch (format) {
    case "responses":
      return decodeResponsesRequest(model, record);
    case "messages":
      return decodeMessagesRequest(model, record);
    case "interactions":
      return decodeInteractionsRequest(model, record);
    default:
      return decodeChatRequest(model, record);
  }
}

function baseRequest(model: string, record: Json): Omit<IrRequest, "messages"> {
  const maxTokens =
    num(record.max_tokens) ?? num(record.max_completion_tokens) ?? num(record.max_output_tokens);
  const generationConfig = asRecord(record.generation_config);
  const reasoning = asRecord(record.reasoning);
  const reasoningEffort =
    str(record.reasoning_effort) ??
    str(reasoning?.effort) ??
    str(generationConfig?.thinking_level) ??
    str(record.thinking_level);
  return {
    model,
    temperature: num(record.temperature),
    topP: num(record.top_p),
    maxTokens: maxTokens ?? num(generationConfig?.max_output_tokens),
    reasoningEffort,
    stream: record.stream === true,
  };
}

function decodeChatRequest(model: string, record: Json): IrRequest {
  const messages: IrMessage[] = [];
  const ledger = new ToolCallLedger();
  for (const raw of asArray(record.messages)) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = str(message.role);
    if (!role) continue;
    const content = message.content;
    const parts: IrPart[] = [];

    if (typeof content === "string") {
      if (content.length > 0) parts.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      for (const rawPart of content) {
        const part = asRecord(rawPart);
        if (!part) continue;
        const type = str(part.type);
        if (type === "text" && typeof part.text === "string") {
          parts.push({ type: "text", text: part.text });
        } else if (type === "image_url") {
          const image = asRecord(part.image_url);
          const url = str(image?.url) ?? str(part.image_url);
          if (url) parts.push({ type: "image", url });
        }
      }
    }

    for (const rawCall of asArray(message.tool_calls)) {
      const call = asRecord(rawCall);
      const fn = asRecord(call?.function);
      const name = str(fn?.name);
      if (!call || !name) continue;
      parts.push({
        type: "tool_call",
        id: ledger.open(str(call.id)),
        name,
        arguments: str(fn?.arguments) ?? "{}",
      });
    }

    if (role === "tool") {
      const callId = ledger.settle(str(message.tool_call_id));
      // 无主结果无法配对；丢弃它比发出非法历史安全。
      if (callId === undefined) continue;
      messages.push({
        role: "tool",
        parts: [{ type: "tool_result", callId, output: textOf(content) }],
      });
      continue;
    }

    if (role !== "system" && role !== "user" && role !== "assistant") continue;
    messages.push({ role, parts });
  }

  ledger.reconcile(messages);

  return {
    ...baseRequest(model, record),
    messages,
    tools: decodeOpenAiTools(record.tools),
  };
}

function decodeOpenAiTools(value: unknown): IrTool[] | undefined {
  const tools: IrTool[] = [];
  for (const raw of asArray(value)) {
    const fn = asRecord(asRecord(raw)?.function);
    const name = str(fn?.name);
    if (!fn || !name) continue;
    tools.push({ name, description: str(fn.description) ?? "", parameters: fn.parameters ?? {} });
  }
  return tools.length > 0 ? tools : undefined;
}

function decodeResponsesRequest(model: string, record: Json): IrRequest {
  const messages: IrMessage[] = [];
  const ledger = new ToolCallLedger();
  const instructions = record.instructions;
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", parts: [{ type: "text", text: instructions }] });
  }
  const input = record.input;
  if (typeof input === "string") {
    messages.push({ role: "user", parts: [{ type: "text", text: input }] });
  } else {
    for (const raw of asArray(input)) {
      const item = asRecord(raw);
      if (!item) continue;
      const type = str(item.type);
      if (type === "function_call") {
        const name = str(item.name);
        if (!name) continue;
        // `call_id` is the pairing key for `function_call_output`; `id` (fc_…)
        // is a different opaque item id, kept only as an alias for histories
        // that omit `call_id` on either side.
        const call: IrPart = {
          type: "tool_call",
          id: ledger.open(str(item.call_id) ?? str(item.id), str(item.id)),
          name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        };
        // Responses flattens a parallel tool-calling turn into sibling
        // `function_call` items. They must merge into one assistant message —
        // one call per message makes the Chat Completions history invalid.
        // The tail is only `assistant` while the turn is open: a result or a
        // new user turn closes it.
        const tail = messages[messages.length - 1];
        if (tail && tail.role === "assistant") {
          tail.parts.push(call);
        } else {
          messages.push({ role: "assistant", parts: [call] });
        }
        continue;
      }
      if (type === "function_call_output") {
        const callId = ledger.settle(str(item.call_id) ?? str(item.id));
        // 无主结果（对应调用不在历史里）无法配对，丢弃比发出非法历史安全。
        if (!callId) continue;
        messages.push({
          role: "tool",
          parts: [{ type: "tool_result", callId, output: textOf(item.output) }],
        });
        continue;
      }
      if (type === "reasoning" || type === "item_reference") continue;
      const role = str(item.role);
      if (!role) continue;
      const parts: IrPart[] = [];
      const content = item.content;
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else {
        for (const rawPart of asArray(content)) {
          const part = asRecord(rawPart);
          if (!part) continue;
          const partType = str(part.type);
          if (partType === "input_text" || partType === "output_text" || partType === "text") {
            const text = str(part.text);
            if (text) parts.push({ type: "text", text });
          } else if (partType === "input_image" || partType === "image_url") {
            const url = str(part.image_url) ?? str(asRecord(part.image_url)?.url);
            if (url) parts.push({ type: "image", url });
          }
        }
      }
      const normalizedRole = role === "developer" ? "system" : role;
      if (normalizedRole !== "system" && normalizedRole !== "user" && normalizedRole !== "assistant") continue;
      messages.push({ role: normalizedRole, parts });
    }
  }

  ledger.reconcile(messages);

  const tools: IrTool[] = [];
  for (const raw of asArray(record.tools)) {
    const tool = asRecord(raw);
    if (!tool || str(tool.type) !== "function") continue;
    const name = str(tool.name);
    if (!name) continue;
    tools.push({ name, description: str(tool.description) ?? "", parameters: tool.parameters ?? {} });
  }

  return {
    ...baseRequest(model, record),
    messages,
    tools: tools.length > 0 ? tools : undefined,
  };
}

function decodeMessagesRequest(model: string, record: Json): IrRequest {
  const messages: IrMessage[] = [];
  const ledger = new ToolCallLedger();
  const system = record.system;
  if (typeof system === "string" && system.trim()) {
    messages.push({ role: "system", parts: [{ type: "text", text: system }] });
  } else if (Array.isArray(system)) {
    const text = textOf(system);
    if (text.trim()) messages.push({ role: "system", parts: [{ type: "text", text }] });
  }

  for (const raw of asArray(record.messages)) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = str(message.role);
    if (role !== "user" && role !== "assistant") continue;
    const parts: IrPart[] = [];
    const content = message.content;
    if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    } else {
      for (const rawBlock of asArray(content)) {
        const block = asRecord(rawBlock);
        if (!block) continue;
        const type = str(block.type);
        if (type === "text") {
          const text = str(block.text);
          if (text) parts.push({ type: "text", text });
        } else if (type === "image") {
          const source = asRecord(block.source);
          if (str(source?.type) === "base64") {
            const mediaType = str(source?.media_type) ?? "image/png";
            parts.push({ type: "image", url: `data:${mediaType};base64,${str(source?.data) ?? ""}` });
          } else if (str(source?.url)) {
            parts.push({ type: "image", url: str(source?.url)! });
          }
        } else if (type === "tool_use") {
          const name = str(block.name);
          if (!name) continue;
          parts.push({
            type: "tool_call",
            id: ledger.open(str(block.id)),
            name,
            arguments: JSON.stringify(block.input ?? {}),
          });
        } else if (type === "tool_result") {
          const callId = ledger.settle(str(block.tool_use_id));
          // 无主结果无法配对；丢弃它比发出非法历史安全。
          if (callId === undefined) continue;
          parts.push({
            type: "tool_result",
            callId,
            output: textOf(block.content),
            isError: block.is_error === true,
          });
        }
      }
    }
    messages.push({ role, parts });
  }

  ledger.reconcile(messages);

  const tools: IrTool[] = [];
  for (const raw of asArray(record.tools)) {
    const tool = asRecord(raw);
    const name = str(tool?.name);
    if (!tool || !name) continue;
    tools.push({ name, description: str(tool.description) ?? "", parameters: tool.input_schema ?? {} });
  }

  return {
    ...baseRequest(model, record),
    messages,
    tools: tools.length > 0 ? tools : undefined,
  };
}

function decodeInteractionsRequest(model: string, record: Json): IrRequest {
  const messages: IrMessage[] = [];
  const ledger = new ToolCallLedger();
  const system = str(record.system_instruction);
  if (system && system.trim()) {
    messages.push({ role: "system", parts: [{ type: "text", text: system }] });
  }

  const input = record.input;
  if (typeof input === "string") {
    messages.push({ role: "user", parts: [{ type: "text", text: input }] });
  } else {
    for (const raw of asArray(input)) {
      const step = asRecord(raw);
      if (!step) continue;
      const type = str(step.type);
      if (type === "function_call") {
        const name = str(step.name);
        if (!name) continue;
        const call: IrPart = {
          type: "tool_call",
          id: ledger.open(str(step.call_id) ?? str(step.id)),
          name,
          arguments: typeof step.arguments === "string" ? step.arguments : JSON.stringify(step.arguments ?? {}),
        };
        // 连续的 `function_call` 属于同一回合，合并进仍在打开的 assistant 消息。
        const tail = messages[messages.length - 1];
        if (tail && tail.role === "assistant") {
          tail.parts.push(call);
        } else {
          messages.push({ role: "assistant", parts: [call] });
        }
        continue;
      }
      if (type === "function_result") {
        const callId = ledger.settle(str(step.call_id) ?? str(step.id));
        // 无主结果无法配对；丢弃它比发出非法历史安全。
        if (!callId) continue;
        messages.push({
          role: "tool",
          parts: [
            {
              type: "tool_result",
              callId,
              name: str(step.name),
              output: textOf(step.result),
              isError: step.is_error === true,
            },
          ],
        });
        continue;
      }
      if (type !== "user_input" && type !== "model_output") continue;
      const parts: IrPart[] = [];
      for (const rawBlock of asArray(step.content)) {
        const block = asRecord(rawBlock);
        if (!block) continue;
        const blockType = str(block.type);
        if (blockType === "text") {
          const text = str(block.text);
          if (text) parts.push({ type: "text", text });
        } else if (blockType === "image") {
          const data = str(block.data);
          const uri = str(block.uri);
          if (data) {
            parts.push({
              type: "image",
              url: `data:${str(block.mime_type) ?? "image/png"};base64,${data}`,
            });
          } else if (uri) {
            parts.push({ type: "image", url: uri });
          }
        }
      }
      messages.push({ role: type === "user_input" ? "user" : "assistant", parts });
    }
  }

  ledger.reconcile(messages);

  const tools: IrTool[] = [];
  for (const raw of asArray(record.tools)) {
    const tool = asRecord(raw);
    if (!tool || str(tool.type) !== "function") continue;
    const name = str(tool.name);
    if (!name) continue;
    tools.push({ name, description: str(tool.description) ?? "", parameters: tool.parameters ?? {} });
  }

  return {
    ...baseRequest(model, record),
    messages,
    tools: tools.length > 0 ? tools : undefined,
  };
}

// ---------------------------------------------------------------------------
// upstream request encoding (IR → upstream format)
// ---------------------------------------------------------------------------

export function encodeUpstreamRequest(format: ApiFormat, ir: IrRequest): Json {
  switch (format) {
    case "responses":
      return encodeResponsesRequest(ir);
    case "messages":
      return encodeMessagesRequest(ir);
    case "interactions":
      return encodeInteractionsRequest(ir);
    default:
      return encodeChatRequest(ir);
  }
}

function encodeOpenAiTools(ir: IrRequest): unknown[] | undefined {
  if (!ir.tools || ir.tools.length === 0) return undefined;
  return ir.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
    },
  }));
}

/**
 * 历史里同一轮的并行工具调用可能被存成多条 assistant 消息。Chat Completions
 * 只接受「一条 assistant 携带多个 tool_calls」，因此把连续、且没有文本内容
 * 的 tool_calls 消息合并成一条 —— 否则上游判定 tool calls 与结果不匹配。
 */
function mergeParallelToolCalls(messages: Json[]): Json[] {
  const merged: Json[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const content = message.content;
    const hasContent =
      typeof content === "string" ? content.length > 0 : Array.isArray(content) && content.length > 0;
    if (
      message.role === "assistant" &&
      previous?.role === "assistant" &&
      Array.isArray(previous.tool_calls) &&
      Array.isArray(message.tool_calls) &&
      !hasContent
    ) {
      previous.tool_calls = [...previous.tool_calls, ...message.tool_calls];
      continue;
    }
    merged.push(message);
  }
  return merged;
}

function encodeChatRequest(ir: IrRequest): Json {
  const wireMessages = ir.messages.flatMap((message): Json[] => {
    const textParts = message.parts.filter((part) => part.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const images = message.parts.filter((part) => part.type === "image") as Array<{
      type: "image";
      url: string;
    }>;
    const calls = message.parts.filter((part) => part.type === "tool_call") as Array<{
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
    }>;
    const results = message.parts.filter((part) => part.type === "tool_result") as Array<{
      type: "tool_result";
      callId: string;
      output: string;
    }>;

    // Anthropic/Interactions carry tool results as blocks inside a user
    // turn; Chat Completions needs one `role:"tool"` message per result.
    // A user turn may also carry text next to those blocks — it must survive
    // as a separate message after the tool results, or the turn loses content.
    if (message.role === "tool" || results.length > 0) {
      const toolMessages = results.map((result) => ({
        role: "tool",
        content: result.output,
        tool_call_id: result.callId,
      }));
      if (message.role === "tool") return toolMessages;
      const remainder: Json = {
        role: message.role,
        content:
          images.length === 0
            ? textParts.map((part) => part.text).join("\n")
            : [
                ...textParts.map((part) => ({ type: "text", text: part.text })),
                ...images.map((part) => ({ type: "image_url", image_url: { url: part.url } })),
              ],
      };
      return textParts.length === 0 && images.length === 0 ? toolMessages : [...toolMessages, remainder];
    }
    const content =
      images.length === 0
        ? textParts.map((part) => part.text).join("\n")
        : [
            ...textParts.map((part) => ({ type: "text", text: part.text })),
            ...images.map((part) => ({ type: "image_url", image_url: { url: part.url } })),
          ];
    const wire: Json = { role: message.role, content };
    if (calls.length > 0) {
      wire.tool_calls = calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      }));
      if (textParts.length === 0 && images.length === 0) wire.content = null;
    }
    return [wire];
  });
  const messages = mergeParallelToolCalls(wireMessages);

  const body: Json = { model: ir.model, messages, stream: ir.stream };
  if (ir.temperature !== undefined) body.temperature = ir.temperature;
  if (ir.topP !== undefined) body.top_p = ir.topP;
  if (ir.maxTokens !== undefined) body.max_tokens = ir.maxTokens;
  if (ir.reasoningEffort && ir.reasoningEffort !== "none") body.reasoning_effort = ir.reasoningEffort;
  if (ir.reasoningEffort === "none") body.reasoning_effort = "none";
  const tools = encodeOpenAiTools(ir);
  if (tools) body.tools = tools;
  return body;
}

function encodeResponsesRequest(ir: IrRequest): Json {
  const input: unknown[] = [];
  let instructions: string | undefined;
  for (const message of ir.messages) {
    const texts = message.parts.filter((part) => part.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const images = message.parts.filter((part) => part.type === "image") as Array<{
      type: "image";
      url: string;
    }>;
    const calls = message.parts.filter((part) => part.type === "tool_call") as Array<{
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
    }>;
    const results = message.parts.filter((part) => part.type === "tool_result") as Array<{
      type: "tool_result";
      callId: string;
      output: string;
    }>;

    if (message.role === "system") {
      instructions = [instructions, ...texts.map((part) => part.text)].filter(Boolean).join("\n");
      continue;
    }
    // Anthropic delivers tool results inside a user turn, so they must be
    // lifted out before the message item is emitted.
    if (message.role === "tool" || results.length > 0) {
      for (const result of results) {
        input.push({ type: "function_call_output", call_id: result.callId, output: result.output });
      }
      if (message.role === "tool") continue;
    }
    for (const call of calls) {
      input.push({
        type: "function_call",
        call_id: call.id,
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }
    if (texts.length > 0 || images.length > 0) {
      const partType = message.role === "assistant" ? "output_text" : "input_text";
      const content: unknown[] = [
        ...texts.map((part) => ({ type: partType, text: part.text })),
        ...images.map((part) => ({ type: "input_image", image_url: part.url })),
      ];
      input.push({ type: "message", role: message.role, content });
    }
  }

  const body: Json = { model: ir.model, input, stream: ir.stream };
  if (instructions) body.instructions = instructions;
  if (ir.temperature !== undefined) body.temperature = ir.temperature;
  if (ir.topP !== undefined) body.top_p = ir.topP;
  if (ir.maxTokens !== undefined) body.max_output_tokens = ir.maxTokens;
  if (ir.reasoningEffort && ir.reasoningEffort !== "none") {
    body.reasoning = { effort: ir.reasoningEffort };
  }
  if (ir.tools && ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
    }));
  }
  return body;
}

function encodeMessagesRequest(ir: IrRequest): Json {
  const systemTexts: string[] = [];
  const messages: Json[] = [];

  const flushToolResults = (results: Json[]) => {
    if (results.length === 0) return;
    messages.push({ role: "user", content: results });
  };
  let pendingResults: Json[] = [];

  for (const message of ir.messages) {
    const texts = message.parts.filter((part) => part.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const images = message.parts.filter((part) => part.type === "image") as Array<{
      type: "image";
      url: string;
    }>;
    const calls = message.parts.filter((part) => part.type === "tool_call") as Array<{
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
    }>;
    const results = message.parts.filter((part) => part.type === "tool_result") as Array<{
      type: "tool_result";
      callId: string;
      output: string;
      isError?: boolean;
    }>;

    if (message.role === "system") {
      systemTexts.push(...texts.map((part) => part.text));
      continue;
    }
    if (message.role === "tool") {
      for (const result of results) {
        pendingResults.push({
          type: "tool_result",
          tool_use_id: result.callId,
          content: result.output,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      continue;
    }
    flushToolResults(pendingResults);
    pendingResults = [];

    // A user turn carrying tool results may also carry text/images; those
    // stay in the same Anthropic user turn, after the lifted result blocks.
    const content: unknown[] = [
      ...results.map((result) => ({
        type: "tool_result",
        tool_use_id: result.callId,
        content: result.output,
        ...(result.isError ? { is_error: true } : {}),
      })),
      ...texts.map((part) => ({ type: "text", text: part.text })),
      ...images.map((part) => {
        const parsed = parseDataUri(part.url);
        return parsed
          ? { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } }
          : { type: "image", source: { type: "url", url: part.url } };
      }),
      ...calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseJsonObject(call.arguments),
      })),
    ];
    if (content.length === 0) continue;
    messages.push({ role: message.role, content });
  }
  flushToolResults(pendingResults);

  const body: Json = {
    model: ir.model,
    max_tokens: ir.maxTokens ?? 4096,
    messages,
    stream: ir.stream,
  };
  if (systemTexts.length > 0) body.system = systemTexts.join("\n");
  if (ir.temperature !== undefined) body.temperature = ir.temperature;
  if (ir.topP !== undefined) body.top_p = ir.topP;
  if (ir.tools && ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters ?? { type: "object", properties: {} },
    }));
  }
  return body;
}

function encodeInteractionsRequest(ir: IrRequest): Json {
  const input: unknown[] = [];
  let systemInstruction: string | undefined;
  for (const message of ir.messages) {
    const texts = message.parts.filter((part) => part.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const images = message.parts.filter((part) => part.type === "image") as Array<{
      type: "image";
      url: string;
    }>;
    const calls = message.parts.filter((part) => part.type === "tool_call") as Array<{
      type: "tool_call";
      id: string;
      name: string;
      arguments: string;
    }>;
    const results = message.parts.filter((part) => part.type === "tool_result") as Array<{
      type: "tool_result";
      callId: string;
      output: string;
      isError?: boolean;
    }>;

    if (message.role === "system") {
      systemInstruction = [systemInstruction, ...texts.map((part) => part.text)].filter(Boolean).join("\n");
      continue;
    }
    // Same as Responses: tool results may ride a user turn (Messages shape).
    if (message.role === "tool" || results.length > 0) {
      for (const result of results) {
        input.push({
          type: "function_result",
          call_id: result.callId,
          result: result.output,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      if (message.role === "tool") continue;
    }
    const content = [
      ...texts.map((part) => ({ type: "text", text: part.text })),
      ...images.map((part) => {
        const parsed = parseDataUri(part.url);
        return parsed
          ? { type: "image", data: parsed.data, mime_type: parsed.mediaType }
          : { type: "image", uri: part.url };
      }),
    ];
    if (content.length > 0) {
      input.push({
        type: message.role === "assistant" ? "model_output" : "user_input",
        content,
      });
    }
    for (const call of calls) {
      input.push({
        type: "function_call",
        id: call.id,
        name: call.name,
        arguments: parseJsonObject(call.arguments),
      });
    }
  }

  const generationConfig: Json = {};
  if (ir.maxTokens !== undefined) generationConfig.max_output_tokens = ir.maxTokens;
  const level = thinkingLevel(ir.reasoningEffort);
  if (level) generationConfig.thinking_level = level;

  const body: Json = {
    model: ir.model,
    input,
    stream: ir.stream,
    // 无状态调用：历史每次全量回传，不依赖 previous_interaction_id。
    store: false,
  };
  if (systemInstruction) body.system_instruction = systemInstruction;
  if (Object.keys(generationConfig).length > 0) body.generation_config = generationConfig;
  if (ir.tools && ir.tools.length > 0) {
    body.tools = ir.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
    }));
  }
  return body;
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// upstream response decoding (upstream format → IR)
// ---------------------------------------------------------------------------

export function decodeUpstreamResponse(format: ApiFormat, payload: unknown): IrResponse {
  const record = asRecord(payload) ?? {};
  switch (format) {
    case "responses":
      return decodeResponsesResponse(record);
    case "messages":
      return decodeMessagesResponse(record);
    case "interactions":
      return decodeInteractionsResponse(record);
    default:
      return decodeChatResponse(record);
  }
}

function usageOf(prompt: number, completion: number, total?: number, cached?: number): IrUsage {
  const promptTokens = Math.max(0, Math.trunc(prompt));
  const completionTokens = Math.max(0, Math.trunc(completion));
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(0, Math.trunc(total ?? promptTokens + completionTokens)),
    ...(cached !== undefined ? { cachedTokens: Math.max(0, Math.trunc(cached)) } : {}),
  };
}

function decodeChatResponse(record: Json): IrResponse {
  const choice = asRecord(asArray(record.choices)[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const usage = asRecord(record.usage);
  const text = typeof message.content === "string"
    ? message.content
    : asArray(message.content)
        .map((part) => str(asRecord(part)?.text) ?? "")
        .join("");
  const reasoning =
    str(message.reasoning_content) ?? str(message.reasoning) ?? undefined;
  const toolCalls = asArray(message.tool_calls)
    .map((raw) => {
      const call = asRecord(raw);
      const fn = asRecord(call?.function);
      const name = str(fn?.name);
      if (!name) return null;
      return {
        id: str(call?.id) ?? `call_${name}`,
        name,
        arguments: str(fn?.arguments) ?? "{}",
      } satisfies IrToolCall;
    })
    .filter((call): call is IrToolCall => call !== null);
  const details = asRecord(usage?.prompt_tokens_details);
  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    usage: usage
      ? usageOf(
          num(usage.prompt_tokens) ?? 0,
          num(usage.completion_tokens) ?? 0,
          num(usage.total_tokens),
          num(details?.cached_tokens),
        )
      : undefined,
    finishReason: normalizeFinishReason(str(choice.finish_reason)),
  };
}

function decodeResponsesResponse(record: Json): IrResponse {
  let text = "";
  let reasoning = "";
  const toolCalls: IrToolCall[] = [];
  for (const raw of asArray(record.output)) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = str(item.type);
    if (type === "function_call") {
      const name = str(item.name);
      if (!name) continue;
      toolCalls.push({
        id: str(item.call_id) ?? str(item.id) ?? `call_${toolCalls.length}`,
        name,
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
      continue;
    }
    if (type === "reasoning") {
      for (const rawSummary of asArray(item.summary)) {
        const summary = asRecord(rawSummary);
        reasoning += str(summary?.text) ?? "";
      }
      continue;
    }
    for (const rawPart of asArray(item.content)) {
      const part = asRecord(rawPart);
      if (str(part?.type) === "output_text") text += str(part?.text) ?? "";
    }
  }
  const usage = asRecord(record.usage);
  const details = asRecord(usage?.input_tokens_details);
  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    usage: usage
      ? usageOf(
          num(usage.input_tokens) ?? 0,
          num(usage.output_tokens) ?? 0,
          num(usage.total_tokens),
          num(details?.cached_tokens),
        )
      : undefined,
    finishReason:
      toolCalls.length > 0
        ? "tool_calls"
        : str(record.status) === "incomplete"
          ? "length"
          : "stop",
  };
}

function decodeMessagesResponse(record: Json): IrResponse {
  let text = "";
  let reasoning = "";
  const toolCalls: IrToolCall[] = [];
  for (const raw of asArray(record.content)) {
    const block = asRecord(raw);
    if (!block) continue;
    const type = str(block.type);
    if (type === "text") {
      text += str(block.text) ?? "";
    } else if (type === "thinking") {
      reasoning += str(block.thinking) ?? "";
    } else if (type === "tool_use") {
      const name = str(block.name);
      if (!name) continue;
      toolCalls.push({
        id: str(block.id) ?? `call_${toolCalls.length}`,
        name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  const usage = asRecord(record.usage);
  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    usage: usage
      ? usageOf(
          num(usage.input_tokens) ?? 0,
          num(usage.output_tokens) ?? 0,
          undefined,
          num(usage.cache_read_input_tokens),
        )
      : undefined,
    finishReason: normalizeFinishReason(str(record.stop_reason)),
  };
}

function decodeInteractionsResponse(record: Json): IrResponse {
  let text = "";
  let reasoning = "";
  const toolCalls: IrToolCall[] = [];
  for (const raw of asArray(record.steps)) {
    const step = asRecord(raw);
    if (!step) continue;
    const type = str(step.type);
    if (type === "function_call") {
      const name = str(step.name);
      if (!name) continue;
      toolCalls.push({
        id: str(step.id) ?? `call_${toolCalls.length}`,
        name,
        arguments: JSON.stringify(step.arguments ?? {}),
      });
      continue;
    }
    if (type === "thought") {
      for (const rawSummary of asArray(step.summary)) {
        reasoning += str(asRecord(rawSummary)?.text) ?? "";
      }
      continue;
    }
    if (type === "model_output") {
      for (const rawPart of asArray(step.content)) {
        if (str(asRecord(rawPart)?.type) === "text") {
          text += str(asRecord(rawPart)?.text) ?? "";
        }
      }
    }
  }
  const usage = asRecord(record.usage);
  return {
    text,
    reasoning: reasoning || undefined,
    toolCalls,
    usage: usage
      ? usageOf(
          num(usage.total_input_tokens) ?? 0,
          num(usage.total_output_tokens) ?? 0,
          num(usage.total_tokens),
          num(usage.total_cached_tokens),
        )
      : undefined,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

// ---------------------------------------------------------------------------
// upstream stream decoding (upstream format SSE payload → IR events)
// ---------------------------------------------------------------------------

export interface StreamDecoder {
  feed(payload: string): IrEvent[];
  finish(): IrEvent[];
}

export function createStreamDecoder(format: ApiFormat): StreamDecoder {
  switch (format) {
    case "responses":
      return new ResponsesStreamDecoder();
    case "messages":
      return new MessagesStreamDecoder();
    case "interactions":
      return new InteractionsStreamDecoder();
    default:
      return new ChatStreamDecoder();
  }
}

class ChatStreamDecoder implements StreamDecoder {
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage?: IrUsage;
  private done = false;
  private flushed = false;

  feed(payload: string): IrEvent[] {
    if (this.done) return [];
    if (payload === "[DONE]") {
      const events = this.flushToolCalls();
      events.push({ type: "finish", reason: this.toolCalls.size > 0 ? "tool_calls" : "stop" });
      this.done = true;
      return events;
    }
    const record = asRecord(this.parse(payload));
    if (!record) return [];
    const events: IrEvent[] = [];
    const usage = asRecord(record.usage);
    if (usage) {
      const details = asRecord(usage.prompt_tokens_details);
      this.usage = usageOf(
        num(usage.prompt_tokens) ?? 0,
        num(usage.completion_tokens) ?? 0,
        num(usage.total_tokens),
        num(details?.cached_tokens),
      );
      events.push({ type: "usage", usage: this.usage });
    }
    const choice = asRecord(asArray(record.choices)[0]);
    if (!choice) return events;
    const delta = asRecord(choice.delta) ?? {};
    const reasoning = str(delta.reasoning_content) ?? str(delta.reasoning);
    if (reasoning) events.push({ type: "reasoning", text: reasoning });
    const content = delta.content;
    if (typeof content === "string" && content.length > 0) {
      events.push({ type: "text", text: content });
    } else if (Array.isArray(content)) {
      const text = content.map((part) => str(asRecord(part)?.text) ?? "").join("");
      if (text) events.push({ type: "text", text });
    }
    for (const raw of asArray(delta.tool_calls)) {
      const fragment = asRecord(raw);
      if (!fragment) continue;
      const index = num(fragment.index) ?? 0;
      const current = this.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      const id = str(fragment.id);
      if (id) current.id = id;
      const fn = asRecord(fragment.function);
      const name = str(fn?.name);
      if (name) current.name = name;
      const args = str(fn?.arguments);
      if (args) current.arguments += args;
      this.toolCalls.set(index, current);
    }
    const finishReason = str(choice.finish_reason);
    if (finishReason) {
      events.push(...this.flushToolCalls());
      events.push({ type: "finish", reason: normalizeFinishReason(finishReason) });
      this.done = true;
    }
    return events;
  }

  finish(): IrEvent[] {
    if (this.done) return [];
    const events = this.flushToolCalls();
    events.push({ type: "finish", reason: this.toolCalls.size > 0 ? "tool_calls" : "stop" });
    this.done = true;
    return events;
  }

  private flushToolCalls(): IrEvent[] {
    if (this.flushed) return [];
    this.flushed = true;
    const events: IrEvent[] = [];
    for (const [index, call] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue;
      events.push({
        type: "tool_call",
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments || "{}",
      });
    }
    return events;
  }

  private parse(payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}

class ResponsesStreamDecoder implements StreamDecoder {
  private readonly toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  private usage?: IrUsage;
  private finishReason: string | undefined;
  private done = false;

  feed(payload: string): IrEvent[] {
    if (this.done) return [];
    if (payload === "[DONE]") return this.finish();
    const record = asRecord(this.parse(payload));
    if (!record) return [];
    const type = str(record.type);
    const events: IrEvent[] = [];
    switch (type) {
      case "response.output_text.delta": {
        const text = str(record.delta);
        if (text) events.push({ type: "text", text });
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const text = str(record.delta);
        if (text) events.push({ type: "reasoning", text });
        break;
      }
      // Calls are keyed by `output_index` in every event (added / delta /
      // done / completed all carry it); item ids are only used as a fallback.
      case "response.output_item.added": {
        const item = asRecord(record.item);
        if (item && str(item.type) === "function_call") {
          const key = String(record.output_index ?? 0);
          this.toolCalls.set(key, {
            id: str(item.call_id) ?? str(item.id) ?? key,
            name: str(item.name) ?? "",
            arguments: "",
          });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const key = String(record.output_index ?? 0);
        const call = this.toolCalls.get(key) ?? { id: key, name: "", arguments: "" };
        const args = str(record.delta);
        if (args) call.arguments += args;
        this.toolCalls.set(key, call);
        break;
      }
      case "response.output_item.done": {
        const item = asRecord(record.item);
        if (item && str(item.type) === "function_call") {
          const key = String(record.output_index ?? 0);
          const call = this.toolCalls.get(key) ?? { id: key, name: "", arguments: "" };
          if (!call.name) call.name = str(item.name) ?? "";
          if (!call.arguments) call.arguments = str(item.arguments) ?? "";
          this.toolCalls.set(key, call);
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = asRecord(record.response) ?? record;
        const usage = asRecord(response.usage);
        if (usage) {
          const details = asRecord(usage.input_tokens_details);
          this.usage = usageOf(
            num(usage.input_tokens) ?? 0,
            num(usage.output_tokens) ?? 0,
            num(usage.total_tokens),
            num(details?.cached_tokens),
          );
          events.push({ type: "usage", usage: this.usage });
        }
        for (const raw of asArray(response.output)) {
          const item = asRecord(raw);
          if (!item || str(item.type) !== "function_call") continue;
          const name = str(item.name);
          if (!name) continue;
          const callId = str(item.call_id) ?? str(item.id) ?? `call_${name}`;
          const key = String(record.output_index ?? 0);
          // output_item.done 已登记过同一个调用时，只补全缺失的字段。
          const existing = this.toolCalls.get(key);
          this.toolCalls.set(key, {
            id: existing?.id || callId,
            name: existing?.name || name,
            arguments:
              existing?.arguments ||
              (typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})),
          });
        }
        this.finishReason = type === "response.incomplete" ? "length" : "stop";
        events.push(...this.finish());
        break;
      }
      case "error":
      case "response.failed": {
        const error = asRecord(record.error) ?? asRecord(asRecord(record.response)?.error);
        events.push({
          type: "error",
          message: str(error?.message) ?? "Upstream stream failed.",
        });
        this.done = true;
        break;
      }
      default:
        break;
    }
    return events;
  }

  finish(): IrEvent[] {
    if (this.done) return [];
    this.done = true;
    const events: IrEvent[] = [];
    let index = 0;
    for (const call of this.toolCalls.values()) {
      if (!call.name) continue;
      events.push({
        type: "tool_call",
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments || "{}",
      });
      index += 1;
    }
    events.push({
      type: "finish",
      reason: events.length > 0 ? "tool_calls" : this.finishReason ?? "stop",
    });
    return events;
  }

  private parse(payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}

class MessagesStreamDecoder implements StreamDecoder {
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage: IrUsage = usageOf(0, 0);
  private stopReason: string | undefined;
  private done = false;

  feed(payload: string): IrEvent[] {
    if (this.done) return [];
    if (payload === "[DONE]") return this.finish();
    const record = asRecord(this.parse(payload));
    if (!record) return [];
    const type = str(record.type);
    const events: IrEvent[] = [];
    switch (type) {
      case "message_start": {
        const usage = asRecord(asRecord(record.message)?.usage);
        if (usage) {
          this.usage = usageOf(
            num(usage.input_tokens) ?? 0,
            num(usage.output_tokens) ?? 0,
            undefined,
            num(usage.cache_read_input_tokens),
          );
          events.push({ type: "usage", usage: this.usage });
        }
        break;
      }
      case "content_block_start": {
        const block = asRecord(record.content_block);
        if (str(block?.type) === "tool_use") {
          const index = num(record.index) ?? 0;
          this.toolCalls.set(index, {
            id: str(block?.id) ?? `call_${index}`,
            name: str(block?.name) ?? "",
            arguments: "",
          });
        }
        break;
      }
      case "content_block_delta": {
        const delta = asRecord(record.delta);
        const deltaType = str(delta?.type);
        if (deltaType === "text_delta") {
          const text = str(delta?.text);
          if (text) events.push({ type: "text", text });
        } else if (deltaType === "thinking_delta") {
          const text = str(delta?.thinking);
          if (text) events.push({ type: "reasoning", text });
        } else if (deltaType === "input_json_delta") {
          const index = num(record.index) ?? 0;
          const call = this.toolCalls.get(index) ?? { id: `call_${index}`, name: "", arguments: "" };
          call.arguments += str(delta?.partial_json) ?? "";
          this.toolCalls.set(index, call);
        }
        break;
      }
      case "message_delta": {
        const usage = asRecord(record.usage);
        if (usage) {
          this.usage = usageOf(
            this.usage.promptTokens,
            num(usage.output_tokens) ?? this.usage.completionTokens,
            undefined,
            this.usage.cachedTokens,
          );
          events.push({ type: "usage", usage: this.usage });
        }
        this.stopReason = str(asRecord(record.delta)?.stop_reason) ?? this.stopReason;
        break;
      }
      case "message_stop":
        events.push(...this.finish());
        break;
      case "error": {
        const error = asRecord(record.error);
        events.push({ type: "error", message: str(error?.message) ?? "Upstream stream failed." });
        this.done = true;
        break;
      }
      default:
        break;
    }
    return events;
  }

  finish(): IrEvent[] {
    if (this.done) return [];
    this.done = true;
    const events: IrEvent[] = [];
    for (const [index, call] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue;
      events.push({
        type: "tool_call",
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments || "{}",
      });
    }
    events.push({
      type: "finish",
      reason: events.length > 0 ? "tool_calls" : normalizeFinishReason(this.stopReason),
    });
    return events;
  }

  private parse(payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}

class InteractionsStreamDecoder implements StreamDecoder {
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage?: IrUsage;
  private done = false;

  feed(payload: string): IrEvent[] {
    if (this.done) return [];
    if (payload === "[DONE]") return this.finish();
    const record = asRecord(this.parse(payload));
    if (!record) return [];
    const type = str(record.event_type) ?? str(record.type);
    const events: IrEvent[] = [];
    switch (type) {
      case "step.start": {
        const step = asRecord(record.step);
        if (str(step?.type) === "function_call") {
          const index = num(record.index) ?? 0;
          this.toolCalls.set(index, {
            id: str(step?.id) ?? `call_${index}`,
            name: str(step?.name) ?? "",
            arguments: "",
          });
        }
        break;
      }
      case "step.delta": {
        const delta = asRecord(record.delta);
        const deltaType = str(delta?.type);
        if (deltaType === "text") {
          const text = str(delta?.text);
          if (text) events.push({ type: "text", text });
        } else if (deltaType === "thought_summary") {
          const content = asRecord(delta?.content);
          const text = str(content?.text);
          if (text) events.push({ type: "reasoning", text });
        } else if (deltaType === "arguments_delta") {
          const index = num(record.index) ?? 0;
          const call = this.toolCalls.get(index) ?? { id: `call_${index}`, name: "", arguments: "" };
          call.arguments += str(delta?.arguments) ?? "";
          this.toolCalls.set(index, call);
        }
        break;
      }
      case "interaction.completed": {
        const interaction = asRecord(record.interaction) ?? record;
        const usage = asRecord(interaction.usage);
        if (usage) {
          this.usage = usageOf(
            num(usage.total_input_tokens) ?? 0,
            num(usage.total_output_tokens) ?? 0,
            num(usage.total_tokens),
            num(usage.total_cached_tokens),
          );
          events.push({ type: "usage", usage: this.usage });
        }
        for (const raw of asArray(interaction.steps)) {
          const step = asRecord(raw);
          if (!step || str(step.type) !== "function_call") continue;
          const name = str(step.name);
          if (!name) continue;
          const index = this.toolCalls.size;
          this.toolCalls.set(index, {
            id: str(step.id) ?? `call_${index}`,
            name,
            arguments: JSON.stringify(step.arguments ?? {}),
          });
        }
        events.push(...this.finish());
        break;
      }
      case "error": {
        const error = asRecord(record.error);
        events.push({
          type: "error",
          message: str(error?.message) ?? str(record.message) ?? "Upstream stream failed.",
        });
        this.done = true;
        break;
      }
      default:
        break;
    }
    return events;
  }

  finish(): IrEvent[] {
    if (this.done) return [];
    this.done = true;
    const events: IrEvent[] = [];
    for (const [index, call] of [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.name) continue;
      events.push({
        type: "tool_call",
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.arguments || "{}",
      });
    }
    events.push({
      type: "finish",
      reason: events.length > 0 ? "tool_calls" : "stop",
    });
    return events;
  }

  private parse(payload: string): unknown {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// client response encoding (IR → client format)
// ---------------------------------------------------------------------------

export function encodeClientResponse(
  format: ApiFormat,
  response: IrResponse,
  model: string,
): Json {
  switch (format) {
    case "responses":
      return encodeResponsesResponse(response, model);
    case "messages":
      return encodeMessagesResponse(response, model);
    case "interactions":
      return encodeInteractionsResponse(response, model);
    default:
      return encodeChatResponse(response, model);
  }
}

function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}${random}`;
}

function encodeChatResponse(response: IrResponse, model: string): Json {
  const message: Json = { role: "assistant", content: response.text };
  if (response.reasoning) message.reasoning_content = response.reasoning;
  if (response.toolCalls.length > 0) {
    message.tool_calls = response.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  const usage = response.usage ?? usageOf(0, 0);
  return {
    id: newId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: response.finishReason }],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: usage.cachedTokens } }
        : {}),
    },
  };
}

function encodeResponsesResponse(response: IrResponse, model: string): Json {
  const output: unknown[] = [];
  if (response.reasoning) {
    output.push({
      type: "reasoning",
      id: newId("rs"),
      summary: [{ type: "summary_text", text: response.reasoning }],
    });
  }
  if (response.text) {
    output.push({
      type: "message",
      id: newId("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: response.text, annotations: [] }],
    });
  }
  for (const call of response.toolCalls) {
    output.push({
      type: "function_call",
      id: newId("fc"),
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  const usage = response.usage ?? usageOf(0, 0);
  return {
    id: newId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    output_text: response.text,
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cachedTokens !== undefined
        ? { input_tokens_details: { cached_tokens: usage.cachedTokens } }
        : {}),
    },
  };
}

function encodeMessagesResponse(response: IrResponse, model: string): Json {
  const content: unknown[] = [];
  if (response.reasoning) content.push({ type: "thinking", thinking: response.reasoning });
  if (response.text) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: parseJsonObject(call.arguments),
    });
  }
  const usage = response.usage ?? usageOf(0, 0);
  return {
    id: newId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: response.finishReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokens,
      output_tokens: usage.completionTokens,
      ...(usage.cachedTokens !== undefined
        ? { cache_read_input_tokens: usage.cachedTokens }
        : {}),
    },
  };
}

function encodeInteractionsResponse(response: IrResponse, model: string): Json {
  const steps: unknown[] = [];
  if (response.reasoning) {
    steps.push({ type: "thought", summary: [{ type: "text", text: response.reasoning }] });
  }
  if (response.text) {
    steps.push({ type: "model_output", content: [{ type: "text", text: response.text }] });
  }
  for (const call of response.toolCalls) {
    steps.push({
      type: "function_call",
      id: call.id,
      name: call.name,
      arguments: parseJsonObject(call.arguments),
    });
  }
  const usage = response.usage ?? usageOf(0, 0);
  return {
    id: newId("int"),
    object: "interaction",
    model,
    status: "completed",
    steps,
    usage: {
      total_input_tokens: usage.promptTokens,
      total_output_tokens: usage.completionTokens,
      total_tokens: usage.totalTokens,
      ...(usage.cachedTokens !== undefined
        ? { total_cached_tokens: usage.cachedTokens }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// client stream encoding (IR events → client-format SSE)
// ---------------------------------------------------------------------------

export interface StreamEncoder {
  start(): string;
  push(event: IrEvent): string;
  end(): string;
}

function sse(event: string | null, data: unknown): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return `${event ? `event: ${event}\n` : ""}data: ${payload}\n\n`;
}

export function createStreamEncoder(format: ApiFormat, model: string): StreamEncoder {
  switch (format) {
    case "responses":
      return new ResponsesStreamEncoder(model);
    case "messages":
      return new MessagesStreamEncoder(model);
    case "interactions":
      return new InteractionsStreamEncoder(model);
    default:
      return new ChatStreamEncoder(model);
  }
}

class ChatStreamEncoder implements StreamEncoder {
  private readonly model: string;
  private readonly id = newId("chatcmpl");
  private readonly created = Math.floor(Date.now() / 1000);
  private toolIndex = 0;
  private usage?: IrUsage;
  private finished = false;

  constructor(model: string) {
    this.model = model;
  }

  start(): string {
    return "";
  }

  push(event: IrEvent): string {
    if (event.type === "text") {
      return this.chunk({ content: event.text });
    }
    if (event.type === "reasoning") {
      return this.chunk({ reasoning_content: event.text });
    }
    if (event.type === "tool_call") {
      const index = this.toolIndex++;
      return this.chunk({
        tool_calls: [
          {
            index,
            id: event.id,
            type: "function",
            function: { name: event.name, arguments: event.arguments },
          },
        ],
      });
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return "";
    }
    if (event.type === "error") {
      return sse(null, { error: { message: event.message, type: "api_error" } });
    }
    if (event.type === "finish") {
      this.finished = true;
      let out = sse(null, {
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [{ index: 0, delta: {}, finish_reason: event.reason }],
      });
      if (this.usage) {
        out += sse(null, {
          id: this.id,
          object: "chat.completion.chunk",
          created: this.created,
          model: this.model,
          choices: [],
          usage: {
            prompt_tokens: this.usage.promptTokens,
            completion_tokens: this.usage.completionTokens,
            total_tokens: this.usage.totalTokens,
            ...(this.usage.cachedTokens !== undefined
              ? { prompt_tokens_details: { cached_tokens: this.usage.cachedTokens } }
              : {}),
          },
        });
      }
      return `${out}data: [DONE]\n\n`;
    }
    return "";
  }

  end(): string {
    return this.finished ? "" : this.push({ type: "finish", reason: "stop" });
  }

  private chunk(delta: Json): string {
    return sse(null, {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    });
  }
}

class ResponsesStreamEncoder implements StreamEncoder {
  private readonly model: string;
  private readonly id = newId("resp");
  private readonly created = Math.floor(Date.now() / 1000);
  private outputIndex = -1;
  private currentItem: "message" | "reasoning" | null = null;
  private readonly output: unknown[] = [];
  private readonly textByIndex = new Map<number, string>();
  private readonly reasoningByIndex = new Map<number, string>();
  private usage?: IrUsage;
  private finished = false;

  constructor(model: string) {
    this.model = model;
  }

  start(): string {
    return sse("response.created", {
      type: "response.created",
      response: {
        id: this.id,
        object: "response",
        created_at: this.created,
        model: this.model,
        status: "in_progress",
        output: [],
      },
    });
  }

  push(event: IrEvent): string {
    if (event.type === "text") {
      let out = this.openItem("message");
      this.textByIndex.set(
        this.outputIndex,
        (this.textByIndex.get(this.outputIndex) ?? "") + event.text,
      );
      out += sse("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: `msg_${this.outputIndex}`,
        output_index: this.outputIndex,
        content_index: 0,
        delta: event.text,
      });
      return out;
    }
    if (event.type === "reasoning") {
      let out = this.openItem("reasoning");
      this.reasoningByIndex.set(
        this.outputIndex,
        (this.reasoningByIndex.get(this.outputIndex) ?? "") + event.text,
      );
      out += sse("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        item_id: `rs_${this.outputIndex}`,
        output_index: this.outputIndex,
        summary_index: 0,
        delta: event.text,
      });
      return out;
    }
    if (event.type === "tool_call") {
      let out = this.closeItem();
      this.outputIndex += 1;
      const index = this.outputIndex;
      this.output.push({
        type: "function_call",
        id: `fc_${index}`,
        call_id: event.id,
        name: event.name,
        arguments: event.arguments,
        status: "completed",
      });
      out += (
        sse("response.output_item.added", {
          type: "response.output_item.added",
          output_index: index,
          item: {
            type: "function_call",
            id: `fc_${index}`,
            call_id: event.id,
            name: event.name,
            arguments: "",
          },
        }) +
        sse("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: `fc_${index}`,
          output_index: index,
          delta: event.arguments,
        }) +
        sse("response.output_item.done", {
          type: "response.output_item.done",
          output_index: index,
          item: {
            type: "function_call",
            id: `fc_${index}`,
            call_id: event.id,
            name: event.name,
            arguments: event.arguments,
            status: "completed",
          },
        })
      );
      return out;
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return "";
    }
    if (event.type === "error") {
      return sse("error", { type: "error", error: { message: event.message, code: "api_error" } });
    }
    if (event.type === "finish") {
      this.finished = true;
      const usage = this.usage ?? usageOf(0, 0);
      return this.closeItem() + sse("response.completed", {
        type: "response.completed",
        response: {
          id: this.id,
          object: "response",
          created_at: this.created,
          model: this.model,
          status: "completed",
          output: this.output,
          usage: {
            input_tokens: usage.promptTokens,
            output_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
            ...(usage.cachedTokens !== undefined
              ? { input_tokens_details: { cached_tokens: usage.cachedTokens } }
              : {}),
          },
        },
      });
    }
    return "";
  }

  end(): string {
    return this.finished ? "" : this.push({ type: "finish", reason: "stop" });
  }

  private openItem(type: "message" | "reasoning"): string {
    if (this.currentItem === type) return "";
    let out = this.closeItem();
    this.outputIndex += 1;
    this.currentItem = type;
    if (type === "reasoning") {
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.outputIndex,
        item: { type: "reasoning", id: `rs_${this.outputIndex}`, summary: [] },
      });
      return out;
    }
    out += sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.outputIndex,
      item: { type: "message", id: `msg_${this.outputIndex}`, role: "assistant", content: [] },
    });
    out += sse("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${this.outputIndex}`,
      output_index: this.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    return out;
  }

  private closeItem(): string {
    if (this.currentItem === null) return "";
    const item = this.currentItem === "reasoning"
      ? {
          type: "reasoning",
          id: `rs_${this.outputIndex}`,
          summary: [
            { type: "summary_text", text: this.reasoningByIndex.get(this.outputIndex) ?? "" },
          ],
        }
      : {
          type: "message",
          id: `msg_${this.outputIndex}`,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: this.textByIndex.get(this.outputIndex) ?? "", annotations: [] },
          ],
        };
    this.output.push(item);
    const out = sse("response.output_item.done", {
      type: "response.output_item.done",
      output_index: this.outputIndex,
      item,
    });
    this.currentItem = null;
    return out;
  }
}

class MessagesStreamEncoder implements StreamEncoder {
  private readonly model: string;
  private readonly id = newId("msg");
  private readonly usage: IrUsage = usageOf(0, 0);
  private blockIndex = -1;
  private blockType: "text" | "thinking" | "tool_use" | null = null;
  private finished = false;

  constructor(model: string) {
    this.model = model;
  }

  start(): string {
    return sse("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  push(event: IrEvent): string {
    if (event.type === "text") {
      let out = this.openBlock("text");
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "text_delta", text: event.text },
      });
      return out;
    }
    if (event.type === "reasoning") {
      let out = this.openBlock("thinking");
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "thinking_delta", thinking: event.text },
      });
      return out;
    }
    if (event.type === "tool_call") {
      let out = this.openBlock("tool_use", event.id, event.name);
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index: this.blockIndex,
        delta: { type: "input_json_delta", partial_json: event.arguments },
      });
      return out;
    }
    if (event.type === "usage") {
      this.usage.promptTokens = event.usage.promptTokens || this.usage.promptTokens;
      this.usage.completionTokens = event.usage.completionTokens || this.usage.completionTokens;
      this.usage.totalTokens = this.usage.promptTokens + this.usage.completionTokens;
      if (event.usage.cachedTokens !== undefined) {
        this.usage.cachedTokens = event.usage.cachedTokens;
      }
      return "";
    }
    if (event.type === "error") {
      return sse("error", { type: "error", error: { type: "api_error", message: event.message } });
    }
    if (event.type === "finish") {
      this.finished = true;
      let out = this.closeBlock();
      out += sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: event.reason, stop_sequence: null },
        usage: {
          input_tokens: this.usage.promptTokens,
          output_tokens: this.usage.completionTokens,
          ...(this.usage.cachedTokens !== undefined
            ? { cache_read_input_tokens: this.usage.cachedTokens }
            : {}),
        },
      });
      out += sse("message_stop", { type: "message_stop" });
      return out;
    }
    return "";
  }

  end(): string {
    return this.finished ? "" : this.push({ type: "finish", reason: "stop" });
  }

  private openBlock(type: "text" | "thinking" | "tool_use", id?: string, name?: string): string {
    if (this.blockType === type) return "";
    let out = this.closeBlock();
    this.blockIndex += 1;
    this.blockType = type;
    const block =
      type === "tool_use"
        ? { type: "tool_use", id: id ?? `call_${this.blockIndex}`, name: name ?? "", input: {} }
        : type === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "text", text: "" };
    out += sse("content_block_start", {
      type: "content_block_start",
      index: this.blockIndex,
      content_block: block,
    });
    return out;
  }

  private closeBlock(): string {
    if (this.blockType === null) return "";
    const out = sse("content_block_stop", { type: "content_block_stop", index: this.blockIndex });
    this.blockType = null;
    return out;
  }
}

class InteractionsStreamEncoder implements StreamEncoder {
  private readonly model: string;
  private readonly id = newId("int");
  private stepIndex = -1;
  private stepType: "model_output" | "thought" | "function_call" | null = null;
  private stepText = "";
  private stepSummary = "";
  private stepCall: { id: string; name: string; arguments: string } | null = null;
  private readonly steps: unknown[] = [];
  private usage?: IrUsage;
  private finished = false;

  constructor(model: string) {
    this.model = model;
  }

  start(): string {
    return sse(null, {
      event_type: "interaction.created",
      interaction: { id: this.id, object: "interaction", model: this.model, status: "in_progress" },
    });
  }

  push(event: IrEvent): string {
    if (event.type === "text") {
      let out = this.openStep("model_output", { type: "model_output" });
      this.stepText += event.text;
      out += sse(null, {
        event_type: "step.delta",
        index: this.stepIndex,
        delta: { type: "text", text: event.text },
      });
      return out;
    }
    if (event.type === "reasoning") {
      let out = this.openStep("thought", { type: "thought", summary: [] });
      this.stepSummary += event.text;
      out += sse(null, {
        event_type: "step.delta",
        index: this.stepIndex,
        delta: { type: "thought_summary", content: { type: "text", text: event.text } },
      });
      return out;
    }
    if (event.type === "tool_call") {
      let out = this.openStep("function_call", {
        type: "function_call",
        id: event.id,
        name: event.name,
        arguments: {},
      });
      this.stepCall = { id: event.id, name: event.name, arguments: event.arguments };
      out += sse(null, {
        event_type: "step.delta",
        index: this.stepIndex,
        delta: { type: "arguments_delta", arguments: event.arguments },
      });
      return out;
    }
    if (event.type === "usage") {
      this.usage = event.usage;
      return "";
    }
    if (event.type === "error") {
      return sse(null, { event_type: "error", error: { message: event.message } });
    }
    if (event.type === "finish") {
      this.finished = true;
      const out = this.closeStep();
      const usage = this.usage ?? usageOf(0, 0);
      return (
        out +
        sse(null, {
          event_type: "interaction.completed",
          interaction: {
            id: this.id,
            object: "interaction",
            model: this.model,
            status: "completed",
            steps: this.steps,
            usage: {
              total_input_tokens: usage.promptTokens,
              total_output_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
              ...(usage.cachedTokens !== undefined
                ? { total_cached_tokens: usage.cachedTokens }
                : {}),
            },
          },
        })
      );
    }
    return "";
  }

  end(): string {
    return this.finished ? "" : this.push({ type: "finish", reason: "stop" });
  }

  private openStep(type: "model_output" | "thought" | "function_call", step: Json): string {
    if (this.stepType === type) return "";
    let out = this.closeStep();
    this.stepIndex += 1;
    this.stepType = type;
    out += sse(null, { event_type: "step.start", index: this.stepIndex, step });
    return out;
  }

  private closeStep(): string {
    if (this.stepType === null) return "";
    if (this.stepType === "model_output") {
      this.steps.push({ type: "model_output", content: [{ type: "text", text: this.stepText }] });
    } else if (this.stepType === "thought") {
      this.steps.push({ type: "thought", summary: [{ type: "text", text: this.stepSummary }] });
    } else if (this.stepCall) {
      this.steps.push({
        type: "function_call",
        id: this.stepCall.id,
        name: this.stepCall.name,
        arguments: parseJsonObject(this.stepCall.arguments),
      });
    }
    const out = sse(null, { event_type: "step.stop", index: this.stepIndex });
    this.stepType = null;
    this.stepText = "";
    this.stepSummary = "";
    this.stepCall = null;
    return out;
  }
}

// ---------------------------------------------------------------------------
// client-format error bodies
// ---------------------------------------------------------------------------

export function formatErrorBody(
  format: ApiFormat,
  message: string,
  code = "invalid_request",
): Json {
  switch (format) {
    case "messages":
      return { type: "error", error: { type: code, message } };
    case "interactions":
      return { error: { code, message, status: "INVALID_ARGUMENT" } };
    default:
      return { error: { message, type: code, code } };
  }
}

/** 用 IR 估算 prompt tokens（多模态按序列化长度折算）。 */
export function estimateIrPromptTokens(ir: IrRequest): number {
  let total = 0;
  for (const message of ir.messages) {
    total += Math.ceil(message.role.length / 4);
    for (const part of message.parts) {
      switch (part.type) {
        case "text":
          total += Math.ceil(part.text.length / 4);
          break;
        case "image":
          // 图片 token 无法从字节数精确推导；按固定占位估算。
          total += 256;
          break;
        case "tool_call":
          total += Math.ceil((part.name.length + part.arguments.length) / 4);
          break;
        case "tool_result":
          total += Math.ceil(part.output.length / 4);
          break;
      }
    }
  }
  if (ir.tools) {
    total += Math.ceil(JSON.stringify(ir.tools).length / 4);
  }
  return total;
}
