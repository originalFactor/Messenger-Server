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
import { jsonError, jsonOk } from "@/lib/http";
import { getUserById, getUserQuotaState, listUsageLogs, sumUsage } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET() {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }

  const now = Date.now();
  const [today, recentUsage, quota] = await Promise.all([
    sumUsage(user.id, now - 24 * 60 * 60 * 1000),
    listUsageLogs(user.id, 10),
    getUserQuotaState(user.id),
  ]);

  return jsonOk({
    quota,
    usage: { today },
    recentUsage,
  });
}
