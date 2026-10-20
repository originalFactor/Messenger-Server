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

import { requireUserSession } from "@/lib/auth";
import { jsonError, jsonOk } from "@/lib/http";
import { enforceRateLimits } from "@/lib/rate-limit";
import { ConflictError, NotFoundError, redeemCard } from "@/lib/storage";
import { redeemSchema } from "@/lib/validation";

export const runtime = "nodejs";

/** 同一用户每小时最多 20 次兑换尝试（卡密空间大，但爆破仍需限速）。 */
const REDEEM_RULE = { bucket: "redeem-user", limit: 20, windowMs: 60 * 60 * 1000 };

export async function POST(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const parsed = redeemSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("请输入有效的卡密。", 400);
  }

  const limited = await enforceRateLimits([{ rule: REDEEM_RULE, identity: session.sub }]);
  if (limited) {
    return limited;
  }

  try {
    const result = await redeemCard(session.sub, parsed.data.code);
    return jsonOk({
      redemption: {
        cardCode: result.redemption.cardCode,
        planName: result.redemption.planName,
        quotaTokens: result.redemption.quotaTokens,
        validityDays: result.redemption.validityDays,
        redeemedAt: result.redemption.createdAt,
      },
      quota: {
        balance: result.quota.balance,
        expiresAt: result.quota.expiresAt,
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
