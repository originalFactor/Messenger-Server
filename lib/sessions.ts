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
import type { UserSessionDoc } from "@/lib/types";

/**
 * 服务端会话（`user_sessions`）。
 *
 * 会话不是「登录凭证的黑名单」，而是**同步进度账本**：每条会话记录自己已经
 * 拉取到哪个 `syncVersion`。有了这份账本，服务端才知道「最慢的客户端走到
 * 哪里了」，从而可以安全地删掉已经无人需要的实体墓碑。
 *
 * 为什么需要它：增量同步靠墓碑（`deleted: true` 的 conversation / agent /
 * provider / project）告诉客户端「这条数据没了」。墓碑不能立刻删——某个
 * 客户端可能还停在更早的版本，还没拉到这条墓碑。此前没有任何服务端状态能
 * 回答「谁还在等哪些墓碑」，于是墓碑只能无限堆积。会话补上了这个信息。
 *
 * 生命周期：
 * - 登录/注册签发一条记录，`expiresAt = now + 30 天`，`syncCursor = 0`
 *   （0 = 该会话还没有完成过一次同步，未知其本地状态，保守地阻塞清理）；
 * - 每次 `GET /api/sync?since=N` 把 `syncCursor` 抬到 `max(syncCursor, N)`：
 *   `since` 就是客户端「已经完整应用到哪里」，它只会随完整同步周期前进；
 * - 会话到期（30 天，不滑动续期）或被注销即**硬删除**记录——会话本身不需要
 *   墓碑，行不存在就是无效会话；
 * - 一条会话都没有时不做清理：换设备重新登录的客户端仍带着自己的本地游标，
 *   它需要那些墓碑。
 */

const sessionLog = createLogger("auth");

/** 会话有效期：30 天（Cookie、JWT、库记录三者共用）。 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `lastSeenAt` 写回节流：1 小时内不重复写库。 */
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
  await db.collection<UserSessionDoc>("user_sessions").insertOne({
    _id: sid,
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now + SESSION_TTL_MS),
    syncCursor: 0,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
  return sid;
}

/**
 * 取一条仍然可用的会话；不存在或已过期返回 `null`（过期记录当场删除，
 * TTL 索引只是兜底）。
 */
export async function getActiveSession(sid: string, userId: string): Promise<UserSessionDoc | null> {
  const db = await getDb();
  const sessions = db.collection<UserSessionDoc>("user_sessions");
  const session = await sessions.findOne({ _id: sid });
  if (!session || session.userId !== userId) {
    return null;
  }
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await sessions.deleteOne({ _id: sid });
    sessionLog.info("Session expired.", { userId, sid });
    return null;
  }
  if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
    await sessions.updateOne({ _id: sid }, { $set: { lastSeenAt: now } });
  }
  return session;
}

/**
 * 记录「这条会话已经完整同步到 `cursor`」，返回是否有推进。
 *
 * `cursor` 来自请求的 `ack` 参数——客户端自己上报的、**已持久化**的本地
 * 游标，不是本次请求的 `since`（推完本地改动后的拉取会用 `since = 刚推送
 * 的版本`，而客户端还没应用过它）。只增不减：分页中途崩溃时客户端不会
 * 推进本地游标，服务端也就不会误以为它吃下了后半段。
 */
export async function advanceSessionCursor(sid: string, cursor: number): Promise<boolean> {
  if (cursor <= 0) {
    return false;
  }
  const db = await getDb();
  const result = await db.collection<UserSessionDoc>("user_sessions").updateOne(
    { _id: sid, syncCursor: { $lt: cursor } },
    { $set: { syncCursor: cursor } },
  );
  return result.modifiedCount === 1;
}

/** 注销一条会话（硬删除）。返回是否命中。 */
export async function deleteSession(sid: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.collection<UserSessionDoc>("user_sessions").deleteOne({ _id: sid });
  return result.deletedCount === 1;
}

/**
 * 注销一个账号名下的会话（改密时用 `exceptSid` 保留当前设备）。
 * 返回被删除的条数。
 */
export async function deleteUserSessions(userId: string, exceptSid?: string | null): Promise<number> {
  const db = await getDb();
  const filter = exceptSid ? { userId, _id: { $ne: exceptSid } } : { userId };
  const result = await db.collection<UserSessionDoc>("user_sessions").deleteMany(filter);
  return result.deletedCount;
}

/** 兜底清理已过期会话（TTL 索引之外，登录时顺带扫一遍）。 */
export async function purgeExpiredSessions(): Promise<number> {
  const db = await getDb();
  const result = await db.collection<UserSessionDoc>("user_sessions").deleteMany({
    expiresAt: { $lte: new Date() },
  });
  return result.deletedCount;
}

/**
 * 删除已经无人需要的实体墓碑，返回删除条数。
 *
 * 只删「实体墓碑」——被软删除的 agent / conversation / provider / project。
 * 会话本身从不留墓碑，所以这里与 `user_sessions` 无关。
 *
 * 判据：取该账号**最旧的活跃会话**（`syncCursor` 最小者）的游标 C，凡是
 * `version <= C` 的墓碑都可以删——最慢的客户端都已经同步过那个版本，任何
 * 还活着的客户端都不会再请求它（增量拉取永远只要 `version > since`）。
 *
 * 两条保守规则：
 * - 没有活跃会话时**不清理**：换设备/重登的客户端带着自己的本地游标回来，
 *   仍需要这些墓碑；
 * - 有会话但 `syncCursor == 0`（还没完成过一次同步，本地状态未知）时也
 *   不清理。
 */
export async function purgeSettledTombstones(userId: string): Promise<number> {
  const db = await getDb();
  const oldest = await db
    .collection<UserSessionDoc>("user_sessions")
    .find({ userId, expiresAt: { $gt: new Date() } })
    .sort({ syncCursor: 1 })
    .limit(1)
    .next();
  if (!oldest || oldest.syncCursor <= 0) {
    return 0;
  }
  const cursor = oldest.syncCursor;
  const tombstones = { userId, deleted: true, version: { $lte: cursor } };
  const [agents, conversations, providers, projects] = await Promise.all([
    // 默认 Agent 不能被删除，`isDefault` 兜底只是防御性写法。
    db.collection("agents").deleteMany({ ...tombstones, isDefault: { $ne: true } }),
    db.collection("conversations").deleteMany(tombstones),
    db.collection("providers").deleteMany(tombstones),
    db.collection("projects").deleteMany(tombstones),
  ]);
  const purged =
    agents.deletedCount + conversations.deletedCount + providers.deletedCount + projects.deletedCount;
  if (purged > 0) {
    sessionLog.info("Settled tombstones purged.", {
      userId,
      cursor,
      oldestSessionSid: oldest._id,
      agents: agents.deletedCount,
      conversations: conversations.deletedCount,
      providers: providers.deletedCount,
      projects: projects.deletedCount,
    });
  }
  return purged;
}
