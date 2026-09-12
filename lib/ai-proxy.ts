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
import { getUserByAiApiKey } from "@/lib/storage";
import { estimateTokens } from "@/lib/quota";
import type { StoredUser } from "@/lib/types";

export interface OpenAiErrorOptions {
  type?: string;
  code?: string;
}

/** OpenAI 兼容错误体：{"error": {"message", "type", "code"}}。 */
export function openAiError(message: string, status: number, options: OpenAiErrorOptions = {}) {
  return NextResponse.json(
    {
      error: {
        message,
        type: options.type ?? "invalid_request_error",
        ...(options.code ? { code: options.code } : {}),
      },
    },
    { status },
  );
}

/** 从 Authorization: Bearer <key> 解析并认证 AI API Key。 */
export async function authenticateAiKey(request: Request): Promise<StoredUser | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const apiKey = match?.[1]?.trim();
  if (!apiKey) {
    return null;
  }
  return getUserByAiApiKey(apiKey);
}

/** 粗略估算 prompt tokens；multimodal content 一并按序列化长度折算。 */
export function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let total = 0;
  for (const message of messages) {
    const role = (message as { role?: unknown } | null)?.role;
    const content = (message as { content?: unknown } | null)?.content;
    total += estimateTokens(typeof role === "string" ? role : "");
    total += estimateTokens(JSON.stringify(content ?? ""));
  }
  return total;
}

export function joinUpstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}
