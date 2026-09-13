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
import { appUrl } from "@/lib/env";
import { jsonError, jsonOk } from "@/lib/http";
import { getUserById, getUserQuotaState, listUserQuotaEntitlements } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await requireUserSession();
  if (!session) {
    return jsonError("Unauthorized.", 401);
  }

  const user = await getUserById(session.sub);
  if (!user) {
    return jsonError("User not found.", 404);
  }

  // 多套餐条目模型：额度为未过期条目之和，到期时间取其中最晚者（不限期为 null）。
  const quota = await getUserQuotaState(user.id);
  // App 端「套餐信息」展示：未过期条目的名称/来源/余量/到期时间。
  const quotaEntitlements = (await listUserQuotaEntitlements(user.id, 50))
    .filter((entitlement) => entitlement.expiresAt == null || entitlement.expiresAt > Date.now())
    .map((entitlement) => ({
      planName: entitlement.planName ?? null,
      source: entitlement.source,
      balance: entitlement.balance,
      expiresAt: entitlement.expiresAt,
    }));

  return jsonOk({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      aiApiKey: user.aiApiKey,
      quotaBalance: quota.balance,
      quotaExpiresAt: quota.expiresAt,
      quotaEntitlements,
      avatarUrl: user.avatarUrl ? appUrl("/api/avatars/user") : null,
      avatarVersion: user.avatarVersion ?? null,
      syncVersion: user.syncVersion,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
    },
  });
}
