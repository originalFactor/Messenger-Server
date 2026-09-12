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
import { listAvailableAiModels } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await authenticateAiKey(request);
  if (!user) {
    return openAiError("Invalid API key.", 401, { type: "authentication_error", code: "invalid_api_key" });
  }

  const models = await listAvailableAiModels();
  return jsonOk({
    object: "list",
    data: models.map((model) => ({
      id: model._id,
      object: "model",
      created: Math.floor(model.createdAt / 1000),
      owned_by: "messenger-cloud",
    })),
  });
}
