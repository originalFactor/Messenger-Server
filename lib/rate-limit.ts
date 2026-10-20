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

/**
 * 固定窗口限流（MongoDB 计数）。
 *
 * 需要限流的都是「猜秘密」的端点：登录、注册、卡密预览、卡密兑换。它们
 * 单次成本低（scrypt 约 50ms 但不阻塞事件循环），没有限流时攻击者可以按
 * 实例算力持续爆破。计数落在 `rate_limits` 集合里而不是进程内存：serverless
 * 有多个并发实例，内存计数在横向扩展下等于没有限流。
 *
 * 文档以 `{ _id: "<bucket>:<windowStart>" }` 唯一，靠 `$inc` 原子累加，
 * `expiresAt` 由 TTL 索引自动回收。
 */

import { getDb } from "@/lib/mongo";

interface RateLimitDoc {
  _id: string;
  count: number;
  expiresAt: Date;
}

export interface RateLimitRule {
  /** 计数桶名（每个端点一个）。 */
  bucket: string;
  /** 窗口内允许的次数。 */
  limit: number;
  /** 窗口长度（毫秒）。 */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 本窗口剩余次数。 */
  remaining: number;
  /** 窗口结束的 epoch 毫秒（用于 Retry-After）。 */
  resetAt: number;
}

/**
 * 记录一次尝试并返回是否放行。
 *
 * `$inc` + `$setOnInsert` 的 upsert 是单文档原子操作，多个实例并发时不会
 * 丢计数。窗口用 `Math.floor(now / windowMs)` 对齐，跨窗口自然换 key。
 */
export async function consumeRateLimit(rule: RateLimitRule, identity: string): Promise<RateLimitResult> {
  const db = await getDb();
  const windowStart = Math.floor(Date.now() / rule.windowMs) * rule.windowMs;
  const resetAt = windowStart + rule.windowMs;
  const key = `${rule.bucket}:${identity}:${windowStart}`;
  const doc = await db.collection<RateLimitDoc>("rate_limits").findOneAndUpdate(
    { _id: key },
    {
      $inc: { count: 1 },
      $setOnInsert: { expiresAt: new Date(resetAt) },
    },
    { upsert: true, returnDocument: "after", includeResultMetadata: false },
  );
  const count = doc?.count ?? 1;
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt,
  };
}

/** 从请求里取客户端 IP：优先反向代理写入的转发头，退化到不可用值。 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // 最左项是原始客户端；右侧是逐跳追加的代理地址。
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * 依次消费多条规则（例如「按 IP」+「按账号」），任一超限即返回 429。
 * 返回 `null` 表示放行。
 */
export async function enforceRateLimits(
  attempts: Array<{ rule: RateLimitRule; identity: string }>,
): Promise<Response | null> {
  for (const { rule, identity } of attempts) {
    const result = await consumeRateLimit(rule, identity);
    if (!result.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      return new Response(
        JSON.stringify({ error: "Too many attempts. Try again later." }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(retryAfterSeconds),
            "x-content-type-options": "nosniff",
          },
        },
      );
    }
  }
  return null;
}
