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

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/mongo";
import { createLogger } from "@/lib/runtime-logs";
import type { SessionRevokeReason, UserSessionDoc } from "@/lib/types";

/**
 * 服务端会话（`user_sessions` 集合）。
 *
 * Cookie 里的 JWT 只是凭证：会话是否有效以本集合为准，所以注销、改密、
 * 超时都能即时失效（纯 JWT 做不到）。一个账号可同时有多条会话（每台设备
 * 一条，互不顶替）。
 *
 * 生命周期：
 * - 登录/注册签发一条 `deleted: false` 的记录，`expiresAt = now + 30 天`；
 * - 注销 / 改密 / 超时 → 只置 `deleted: true` 留墓碑，不硬删：墓碑让
 *   「被注销的旧 session」与「未知会话」在日志里可区分，也便于审计；
 * - 墓碑会被自动清理，三种触发：
 *   1. 被出示时当场删除（它已经证明自己没用了）；
 *   2. 该账号**最旧的活跃会话**也已同步过这次变更（它的 `lastSeenAt`
 *      晚于墓碑的 `deletedAt`）——此时没有任何客户端还需要这条墓碑，
 *      立即删除；账号没有活跃会话时同样立即清空；
 *   3. TTL 索引按 `expiresAt` 兜底回收（实例长时间无请求时的保险）。
 *
 * 有效期 30 天且不滑动续期：Cookie、JWT、库里的 `expiresAt` 同时到期，
 * 超时后下一次请求即 401，App 必须重新登录。
 */

const sessionLog = createLogger("auth");

/** 会话有效期：30 天。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * 墓碑兜底保留期：即使没有会话再来「确认同步」，注销后 7 天也清掉，
 * 避免墓碑在无人访问的账号下长期占用空间。
 */
export const SESSION_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** `lastSeenAt` 写回节流：1 小时内不重复写库（墓碑清理挂在这个节拍上）。 */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export interface UserSessionMeta {
  ip?: string | null;
  userAgent?: string | null;
}

/** 新建一条会话并返回它的 sid（写进 JWT 的 `sid` claim）。 */
export async function createUserSession(
  userId: string,
  meta: UserSessionMeta = {},
): Promise<string> {
  const db = await getDb();
  const now = Date.now();
  const sid = randomUUID();
  const doc: UserSessionDoc = {
    _id: sid,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now + SESSION_TTL_MS),
    deleted: false,
    deletedAt: null,
    revokedReason: null,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  };
  await db.collection<UserSessionDoc>("user_sessions").insertOne(doc);
  return sid;
}

/**
 * 清掉该账号已经「无人需要」的墓碑。
 *
 * 墓碑的唯一作用是把「被注销的旧 session」和「不存在的会话」区分开；一旦
 * 最旧的活跃会话都发过请求（`lastSeenAt >= deletedAt`），说明这次变更已经
 * 传播到所有还在用的客户端，墓碑没有读者了，直接删除。账号已无活跃会话时
 * 全部清空。
 */
export async function purgeObservedTombstones(userId: string): Promise<void> {
  const db = await getDb();
  const sessions = db.collection<UserSessionDoc>("user_sessions");
  const oldest = await sessions
    .find({ userId, deleted: false, expiresAt: { $gt: new Date() } })
    .sort({ lastSeenAt: 1 })
    .limit(1)
    .next();
  if (!oldest) {
    const result = await sessions.deleteMany({ userId, deleted: true });
    if (result.deletedCount > 0) {
      sessionLog.info("Session tombstones purged (no live sessions).", { userId, purged: result.deletedCount });
    }
    return;
  }
  const result = await sessions.deleteMany({
    userId,
    deleted: true,
    deletedAt: { $lte: oldest.lastSeenAt },
  });
  if (result.deletedCount > 0) {
    sessionLog.info("Session tombstones purged (oldest session caught up).", {
      userId,
      purged: result.deletedCount,
      oldestSessionSid: oldest._id,
    });
  }
}

/**
 * 取一条仍然可用的会话；不可用时返回 `null`。
 *
 * 三条失效判据：不存在（已清理）、`deleted`（注销/改密）、`expiresAt`
 * 已过（超时）。超时记录转成墓碑后交给自动清理。
 */
export async function getActiveSession(sid: string, userId: string): Promise<UserSessionDoc | null> {
  const db = await getDb();
  const sessions = db.collection<UserSessionDoc>("user_sessions");
  const session = await sessions.findOne({ _id: sid });
  if (!session || session.userId !== userId) {
    return null;
  }
  const now = Date.now();
  if (session.deleted) {
    // 墓碑被出示：确认死亡，直接删除（它已经完成最后一次告知）。
    await sessions.deleteOne({ _id: sid });
    sessionLog.warn("Revoked session presented.", { userId, sid, reason: session.revokedReason ?? "revoked" });
    return null;
  }
  if (session.expiresAt.getTime() <= now) {
    // 超时：转墓碑（保留期结束后由 TTL 回收），并在日志里与「主动注销」区分。
    await sessions.updateOne(
      { _id: sid, deleted: false },
      {
        $set: {
          deleted: true,
          deletedAt: now,
          revokedReason: "expired" satisfies SessionRevokeReason,
          expiresAt: new Date(now + SESSION_TOMBSTONE_TTL_MS),
        },
      },
    );
    sessionLog.info("Session expired.", { userId, sid });
    return null;
  }
  if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
    await sessions.updateOne({ _id: sid }, { $set: { lastSeenAt: now } });
    // 刚写回的 lastSeenAt 就是「本次请求已同步」的证据：若这条会话是最旧的
    // 活跃会话，此刻之前产生的墓碑都已被所有客户端看到，可以回收。
    // 早回收只影响日志能否说出「被注销」，不影响有效性判定（行不存在
    // 与墓碑一样返回 401）。
    await purgeObservedTombstones(userId).catch(() => undefined);
  }
  return session;
}

/** 注销一条会话：留墓碑（随后由自动清理回收）。返回是否命中一条活跃会话。 */
export async function revokeSession(sid: string, reason: SessionRevokeReason): Promise<boolean> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.collection<UserSessionDoc>("user_sessions").updateOne(
    { _id: sid, deleted: false },
    {
      $set: {
        deleted: true,
        deletedAt: now,
        revokedReason: reason,
        expiresAt: new Date(now + SESSION_TOMBSTONE_TTL_MS),
      },
    },
  );
  return result.matchedCount === 1;
}

/**
 * 注销一个账号名下的会话（改密、删号）。`exceptSid` 保留当前会话
 * （改密时当前设备不掉线），返回被注销的条数。
 */
export async function revokeUserSessions(
  userId: string,
  reason: SessionRevokeReason,
  exceptSid?: string | null,
): Promise<number> {
  const db = await getDb();
  const now = Date.now();
  const filter = exceptSid
    ? { userId, deleted: false, _id: { $ne: exceptSid } }
    : { userId, deleted: false };
  const result = await db.collection<UserSessionDoc>("user_sessions").updateMany(filter, {
    $set: {
      deleted: true,
      deletedAt: now,
      revokedReason: reason,
      expiresAt: new Date(now + SESSION_TOMBSTONE_TTL_MS),
    },
  });
  return result.modifiedCount;
}

/**
 * 兜底清理：删掉所有已到期的记录（超时会话与墓碑都算）。
 *
 * TTL 索引负责常态回收，但它由后台线程按分钟级周期扫描，实例刚启动或
 * 长时间无写入时可能滞后；登录是低频事件，顺手扫一遍成本可忽略。
 */
export async function purgeExpiredSessions(): Promise<number> {
  const db = await getDb();
  const result = await db.collection<UserSessionDoc>("user_sessions").deleteMany({
    expiresAt: { $lte: new Date() },
  });
  return result.deletedCount;
}

/** 账号注销时彻底移除该用户的全部会话（含墓碑，用户已不存在）。 */
export async function deleteUserSessions(userId: string): Promise<void> {
  const db = await getDb();
  await db.collection<UserSessionDoc>("user_sessions").deleteMany({ userId });
}
