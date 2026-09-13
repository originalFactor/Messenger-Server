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

import { authenticateAiKey, openAiError } from "@/lib/ai-proxy";
import { jsonOk } from "@/lib/http";
import { getModelPlaza } from "@/lib/model-plaza";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await authenticateAiKey(request);
  if (!user) {
    return openAiError("Invalid API key.", 401, { type: "authentication_error", code: "invalid_api_key" });
  }

  // 模型元数据（context_window / 倍率）与 /v1/chat/completions 的
  // resolveModelMeta 语义一致：override 开启用自定义值（缺失回退
  // models.dev），关闭用 models.dev，多上游不一致取最大上下文。
  const plaza = await getModelPlaza();
  const now = Math.floor(Date.now() / 1000);
  return jsonOk({
    object: "list",
    data: plaza.map((model) => ({
      id: model.modelId,
      object: "model",
      created: now,
      owned_by: "messenger-cloud",
      context_window: model.contextWindow,
    })),
  });
}
