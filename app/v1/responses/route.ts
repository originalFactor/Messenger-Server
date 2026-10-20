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

import { type RELAY_MAX_DURATION_SECONDS, relayCompletion } from "@/lib/ai-relay";

export const runtime = "nodejs";
// 字面量是硬性要求（Next 静态解析 segment config），`satisfies` 保证与
// RELAY_MAX_DURATION_SECONDS 一致，见 ai-relay.ts。
export const maxDuration = 120 satisfies typeof RELAY_MAX_DURATION_SECONDS;

/** OpenAI Responses API 兼容入口。 */
export async function POST(request: Request) {
  return relayCompletion({ format: "responses", request });
}
