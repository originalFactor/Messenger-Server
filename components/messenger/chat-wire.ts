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

import type { MessageEmbed } from "@/lib/types";

/** A content part stored in `MessageEmbed.partsJson` (the clients' shared shape). */
export type StoredPart = {
  type?: string | null;
  text?: string | null;
  callId?: string | null;
  name?: string | null;
  arguments?: string | null;
  output?: string | null;
  isError?: boolean | null;
};

export function parseParts(message: MessageEmbed): StoredPart[] {
  if (!message.partsJson) return [];
  try {
    const parsed = JSON.parse(message.partsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((part): part is StoredPart => Boolean(part && typeof part === "object")) : [];
  } catch {
    return [];
  }
}

export function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

export function splitThinking(content: string): { thinking: string; answer: string } {
  let thinking = "";
  let answer = content;
  const closed = /<think>([\s\S]*?)<\/think>/gi;
  answer = answer.replace(closed, (_match, value: string) => {
    thinking += value;
    return "";
  });
  const openIndex = answer.toLowerCase().indexOf("<think>");
  if (openIndex >= 0) {
    thinking += answer.slice(openIndex + 7);
    answer = answer.slice(0, openIndex);
  }
  return { thinking: thinking.trim(), answer: answer.trim() };
}

// ---------------------------------------------------------------------------
// Workspace tools. Declarations mirror `core/rust/crates/messenger-tools` so the model sees the same
// tools as on the other clients; execution always happens on the project's owner device.
// ---------------------------------------------------------------------------

type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** edit/create change files, so they are only declared for writable conversations. */
  writeAccess: boolean;
};

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

function terminalTool(readOnly: boolean): ToolDefinition {
  return {
    name: "terminal",
    description: readOnly
      ? "Run one command in Messenger's sandboxed app-private workspace and return its combined output and exit code. The agent is in read-only mode, so use this for inspection; do not modify files."
      : "Run one command in Messenger's sandboxed app-private workspace and return its combined output and exit code. The command can create, modify, or delete files.",
    parameters: obj({ command: { type: "string", description: "One command to execute" } }, ["command"]),
    writeAccess: false,
  };
}

const WORKSPACE_TOOLS: ToolDefinition[] = [
  {
    name: "glob",
    description: "Find files matching a glob such as **/*.kt, relative to the agent workspace.",
    parameters: obj({ pattern: { type: "string" }, maxResults: { type: "integer", minimum: 1, maximum: 1000 } }, ["pattern"]),
    writeAccess: false,
  },
  {
    name: "grep",
    description:
      "Fast full-workspace text search with ripgrep: a regular expression (Rust syntax) or fixed string across files; path scopes the search to a file or directory and defaults to the whole workspace.",
    parameters: obj(
      {
        pattern: { type: "string" },
        path: { type: "string" },
        fileGlob: { type: "string" },
        caseSensitive: { type: "boolean" },
        fixedString: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1, maximum: 1000 },
      },
      ["pattern"],
    ),
    writeAccess: false,
  },
  {
    name: "read",
    description: "Read a line range from a text file; paths are relative to the agent workspace unless absolute.",
    parameters: obj(
      { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, maxLines: { type: "integer", minimum: 1, maximum: 2000 } },
      ["path"],
    ),
    writeAccess: false,
  },
  {
    name: "edit",
    description:
      "Replace exact text in one file; replacement must match exactly once unless replaceAll is true. Paths are relative to the agent workspace unless absolute.",
    parameters: obj(
      { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" }, replaceAll: { type: "boolean" } },
      ["path", "oldText", "newText"],
    ),
    writeAccess: true,
  },
  {
    name: "create",
    description: "Create a text file. Existing files are not overwritten unless overwrite is true. Paths are relative to the agent workspace unless absolute.",
    parameters: obj({ path: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" } }, ["path", "content"]),
    writeAccess: true,
  },
];

const REGISTRY: ToolDefinition[] = [terminalTool(true), ...WORKSPACE_TOOLS];

export type WireTool = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

/**
 * The tools declared for one turn of a project conversation: master switch, per-tool config (a
 * missing key means enabled) and the read-only/writable mode — the same rules as the Rust core.
 */
export function resolveTools(enabled: boolean, config: Record<string, boolean> | null | undefined, writable: boolean): WireTool[] {
  if (!enabled) return [];
  return REGISTRY
    .filter((tool) => config?.[tool.name] ?? true)
    .filter((tool) => writable || !tool.writeAccess)
    .map((tool) => (writable && tool.name === "terminal" ? terminalTool(false) : tool))
    .map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

export function isWorkspaceTool(name: string): boolean {
  return REGISTRY.some((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------
// Request history and streaming
// ---------------------------------------------------------------------------

type WireMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

/**
 * Stored messages → chat-completions history. Tool calls and results must pair up or the provider
 * rejects the request, so a call without a stored result (an interrupted turn) is dropped, and so is
 * a result without its call. Reasoning (`<think>`) and failed replies are not sent back.
 */
export function toWireMessages(messages: MessageEmbed[]): WireMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of parseParts(message)) {
      if (part.type === "tool_result" && part.callId) answered.add(part.callId);
    }
  }

  const wire: WireMessage[] = [];
  const declared = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      if (message.status === "ERROR") continue;
      const parts = parseParts(message);
      const text = parts.some((part) => part.type === "text")
        ? parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("")
        : message.content;
      const content = splitThinking(text).answer;
      const toolCalls = parts
        .filter((part) => part.type === "tool_call" && part.callId && part.name && answered.has(part.callId))
        .map((part) => ({
          id: part.callId as string,
          type: "function" as const,
          function: { name: part.name as string, arguments: part.arguments || "{}" },
        }));
      toolCalls.forEach((call) => declared.add(call.id));
      if (!content && toolCalls.length === 0) continue;
      wire.push({ role: "assistant", content: content || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
    } else if (message.role === "tool") {
      for (const part of parseParts(message)) {
        if (part.type === "tool_result" && part.callId && declared.has(part.callId)) {
          wire.push({ role: "tool", tool_call_id: part.callId, content: part.output ?? "" });
        }
      }
    }
  }
  return wire;
}

export type StreamedToolCall = { id: string; name: string; arguments: string };

type ChatChunk = {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    message?: { content?: unknown };
  }>;
};

/** Reads a chat-completions SSE stream, reporting the accumulated text as it grows. */
export async function readChatStream(response: Response, onText: (text: string) => void): Promise<{ text: string; toolCalls: StreamedToolCall[] }> {
  if (!response.body) throw new Error("AI 返回为空");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  const handle = (frame: string) => {
    const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let parsed: ChatChunk;
    try {
      parsed = JSON.parse(data) as ChatChunk;
    } catch {
      return; // keep-alive frames and malformed intermediary events
    }
    const choice = parsed.choices?.[0];
    const chunk = messageText(choice?.delta?.content ?? choice?.message?.content);
    if (chunk) {
      text += chunk;
      onText(text);
    }
    for (const call of choice?.delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      const entry = calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name += call.function.name;
      if (call.function?.arguments) entry.arguments += call.function.arguments;
      calls.set(index, entry);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    frames.forEach(handle);
  }
  if (buffer.trim()) handle(buffer);

  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.name)
    .map((call) => ({ id: call.id || `call_${crypto.randomUUID()}`, name: call.name, arguments: call.arguments || "{}" }));
  return { text, toolCalls };
}
