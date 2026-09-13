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
import { ConflictError, NotFoundError, previewCard } from "@/lib/storage";
import { redeemSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** 兑换前查询卡密信息（套餐快照），不消费卡密。 */
export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = redeemSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("请输入有效的卡密。", 400);
  }

  try {
    const card = await previewCard(parsed.data.code);
    return jsonOk({
      card: {
        code: card.code,
        planName: card.planName,
        quotaTokens: card.quotaTokens,
        validityDays: card.validityDays,
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return jsonError(error.message, 404);
    }
    if (error instanceof ConflictError) {
      return jsonError(error.message, 409);
    }
    throw error;
  }
}
