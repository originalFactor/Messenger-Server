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

import { appUrl } from "@/lib/env";
import { getUserQuotaState, listUserQuotaEntitlements } from "@/lib/storage";
import type { StoredUser } from "@/lib/types";

/** App 端「套餐信息」展示的单条未过期条目。 */
export interface SelfQuotaEntitlementView {
  planName: string | null;
  source: string;
  balance: number;
  /** null = 不限有效期。 */
  expiresAt: number | null;
}

/** `/api/auth/{me,login,register}` 共用的当前用户视图。 */
export interface SelfUserView {
  id: string;
  email: string;
  /** 用户中心设置的昵称；null = 未设置，客户端回落到邮箱。 */
  displayName: string | null;
  /** 邮箱验证时刻；null = 未验证（SMTP 未配置时新版客户端应隐藏提醒）。 */
  emailVerifiedAt: number | null;
  role: string;
  aiApiKey: string;
  quotaBalance: number;
  quotaExpiresAt: number | null;
  quotaEntitlements: SelfQuotaEntitlementView[];
  avatarUrl: string | null;
  avatarVersion: number | null;
  syncVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

/**
 * 当前用户的自视视图。登录 / 注册 / `/me` 必须返回同一份形状：客户端把登录
 * 响应直接当成账号快照（额度卡片、内置 AI 服务商的 aiApiKey 播种都读它），
 * 只给 `/me` 补齐额度字段会让「刚登录的会话」显示 0 额度且没有内置服务商。
 */
export async function buildSelfUserView(
  user: StoredUser,
  /** 登录刚刚写入的时间戳，覆盖文档里的旧值。 */
  lastLoginAt: number | undefined = user.lastLoginAt,
): Promise<SelfUserView> {
  const now = Date.now();
  // 多套餐条目模型：额度为未过期条目之和，到期时间取其中最晚者（不限期为 null）。
  const [quota, entitlements] = await Promise.all([
    getUserQuotaState(user.id),
    listUserQuotaEntitlements(user.id, 50),
  ]);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerifiedAt: user.emailVerifiedAt,
    role: user.role,
    aiApiKey: user.aiApiKey,
    quotaBalance: quota.balance,
    quotaExpiresAt: quota.expiresAt,
    quotaEntitlements: entitlements
      .filter((entitlement) => entitlement.expiresAt == null || entitlement.expiresAt > now)
      .map((entitlement) => ({
        planName: entitlement.planName ?? null,
        source: entitlement.source,
        balance: entitlement.balance,
        expiresAt: entitlement.expiresAt,
      })),
    avatarUrl: user.avatarUrl ? appUrl("/api/avatars/user") : null,
    avatarVersion: user.avatarVersion ?? null,
    syncVersion: user.syncVersion,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt,
  };
}
