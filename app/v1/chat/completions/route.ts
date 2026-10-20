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

import { RELAY_MAX_DURATION_SECONDS, relayCompletion } from "@/lib/ai-relay";

export const runtime = "nodejs";
// 必须 ≥ 上游超时（UPSTREAM_TIMEOUT_MS），否则平台会在上游返回前杀掉
// 函数：客户端拿到空响应、用量也不会结算。Vercel 会按套餐静默钳制该值，
// 部署时需要保证套餐上限不低于此数。
export const maxDuration = RELAY_MAX_DURATION_SECONDS;

/** OpenAI Chat Completions 兼容入口。 */
export async function POST(request: Request) {
  return relayCompletion({ format: "chat", request });
}
