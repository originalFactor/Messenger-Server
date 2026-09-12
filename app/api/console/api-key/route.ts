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

import { requireUserSession } from "@/lib/auth";
import { generateAiApiKey } from "@/lib/apikeys";
import { jsonError, jsonOk } from "@/lib/http";
import { updateUserAiApiKey } from "@/lib/storage";

export const runtime = "nodejs";

/** 重置用户的 AI API Key。旧 Key 立即失效。 */
export async function POST() {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const aiApiKey = generateAiApiKey();
  await updateUserAiApiKey(session.sub, aiApiKey);
  return jsonOk({ aiApiKey });
}
