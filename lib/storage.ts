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

import { randomUUID } from "node:crypto";
import { type ClientSession, type Db, type Filter, MongoServerError } from "mongodb";
import { renewAvatarLock, type AvatarLock } from "@/lib/avatar-locks";
import { generateCardCode, normalizeCardCode } from "@/lib/apikeys";
import { quotaStateFromEntitlements } from "@/lib/quota";
import { getDb, getMongoClient } from "@/lib/mongo";
import type {
  AdminRecentUser,
  AgentDoc,
  AgentUpsertInput,
  CardKeyDoc,
  CardKeyStatus,
  MarketAgentDoc,
  MarketAgentInput,
  ConversationDoc,
  ConversationUpsertInput,
  PlanDoc,
  ProviderDoc,
  ProviderUpsertInput,
  RedemptionDoc,
  SiteOverview,
  SiteSyncOverview,
  StoredUser,
  SyncResponse,
  SyncSummary,
  UpstreamDoc,
  UpstreamModelMeta,
  UsageLogDoc,
  UsageStats,
  UserDoc,
  UserRole,
} from "@/lib/types";
import type { AdminUserView, UserQuotaDoc } from "@/lib/types";
import type { QuotaEntitlementView, QuotaState } from "@/lib/quota";

const DAY_MS = 24 * 60 * 60 * 1000;

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

export function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

function toStoredUser(doc: UserDoc): StoredUser {
  return {
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    // SaaS 改造前注册的用户没有 role 字段，一律视为普通用户。
    role: doc.role ?? "user",
    aiApiKey: doc.aiApiKey ?? "",
    quotaBalance: doc.quotaBalance ?? 0,
    quotaExpiresAt: doc.quotaExpiresAt ?? null,
    avatarUrl: doc.avatarUrl ?? null,
    avatarVersion: doc.avatarVersion ?? null,
    syncVersion: doc.syncVersion,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    lastLoginAt: doc.lastLoginAt,
  };
}

export async function getUserByEmail(email: string): Promise<StoredUser | null> {
  const db = await getDb();
  const doc = await db.collection<UserDoc>("users").findOne({ email });
  return doc ? toStoredUser(doc) : null;
}

export async function getUserById(userId: string): Promise<StoredUser | null> {
  const db = await getDb();
  const doc = await db.collection<UserDoc>("users").findOne({ _id: userId });
  return doc ? toStoredUser(doc) : null;
}

export async function getUserByAiApiKey(apiKey: string): Promise<StoredUser | null> {
  const db = await getDb();
  const doc = await db.collection<UserDoc>("users").findOne({ aiApiKey: apiKey });
  return doc ? toStoredUser(doc) : null;
}

export async function hasAdminUser(session?: ClientSession): Promise<boolean> {
  const db = await getDb();
  const admin = await db.collection<UserDoc>("users").findOne(
    { role: "admin" },
    { projection: { _id: 1 }, session },
  );
  return admin !== null;
}

export interface SaveUserResult {
  syncVersion: number;
  role: UserRole;
}

/**
 * 注册事务：创建用户 + 默认 Agent。若当前没有任何管理员，本次注册的
 * 用户晋升为 admin，并向 system_bootstrap 写入标记文档 —— 标记的
 * 唯一索引让并发注册只产生一名管理员（后到的事务 dup-key 中止）。
 */
export async function saveUser(user: StoredUser): Promise<SaveUserResult> {
  try {
    return await saveUserTransaction(user);
  } catch (error) {
    // 标记文档 dup-key 意味着并发注册已产出管理员：整个事务回滚后
    // 以普通用户身份重试一次。邮箱冲突时重试同样 dup-key，由调用方
    // 映射为 409。
    if (isDuplicateKeyError(error)) {
      return saveUserTransaction(user);
    }
    throw error;
  }
}

async function saveUserTransaction(user: StoredUser): Promise<SaveUserResult> {
  const client = await getMongoClient();
  const session = client.startSession();
  const defaultAgentId = randomUUID();
  let result: SaveUserResult | null = null;

  try {
    await session.withTransaction(async () => {
      const db = await getDb();
      let role: UserRole = "user";
      if (!(await hasAdminUser(session))) {
        role = "admin";
        await db.collection<{ _id: string; grantedToUserId: string; createdAt: number }>("system_bootstrap").insertOne(
          { _id: "admin_bootstrap", grantedToUserId: user.id, createdAt: user.createdAt },
          { session },
        );
      }

      await db.collection<UserDoc>("users").insertOne({
        _id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
        role,
        aiApiKey: user.aiApiKey,
        quotaBalance: 0,
        quotaExpiresAt: null,
        avatarUrl: user.avatarUrl ?? null,
        avatarVersion: user.avatarVersion ?? null,
        syncVersion: 0,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
      }, { session });

      const nextVersion = await bumpSyncVersion(user.id, session);
      await db.collection<AgentDoc>("agents").insertOne({
        _id: defaultAgentId,
        userId: user.id,
        name: "默认 Agent",
        avatarUrl: null,
        avatarVersion: null,
        systemPrompt: "You are a helpful assistant.",
        defaultModelId: null,
        temperature: 0.7,
        topP: 1,
        maxTokens: null,
        reasoningEffort: null,
        isDefault: true,
        followDefaultSystemPrompt: false,
        followDefaultModel: false,
        followDefaultTemperature: false,
        followDefaultTopP: false,
        followDefaultMaxTokens: false,
        followDefaultReasoningEffort: false,
        marketAgentId: null,
        marketAgentVersion: null,
        marketAgentRole: null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        version: nextVersion,
        deleted: false,
      }, { session });
      result = { syncVersion: nextVersion, role };
    });
  } finally {
    await session.endSession();
  }

  if (result === null) {
    throw new Error("The user registration transaction did not commit.");
  }
  return result;
}

export async function updateUserLastLogin(userId: string, lastLoginAt: number): Promise<void> {
  const db = await getDb();
  await db.collection<UserDoc>("users").updateOne(
    { _id: userId },
    { $set: { lastLoginAt, updatedAt: lastLoginAt } },
  );
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<UserDoc>("users").updateOne(
    { _id: userId },
    { $set: { passwordHash, updatedAt: Date.now() } },
  );
  if (result.matchedCount !== 1) {
    throw new NotFoundError("User not found.");
  }
}

export async function deleteUserAccount(userId: string): Promise<{ agentIds: string[]; marketAgentIds: string[] }> {
  const client = await getMongoClient();
  const session = client.startSession();
  let agentIds: string[] = [];
  let marketAgentIds: string[] = [];

  try {
    await session.withTransaction(async () => {
      const db = await getDb();
      const user = await db.collection<UserDoc>("users").findOne({ _id: userId }, { session });
      if (!user) {
        throw new NotFoundError("User not found.");
      }

      agentIds = (await db.collection<AgentDoc>("agents")
        .find({ userId }, { projection: { _id: 1 }, session })
        .toArray()).map((agent) => agent._id);
      marketAgentIds = (await db.collection<MarketAgentDoc>("market_agents")
        .find({ ownerUserId: userId }, { projection: { _id: 1 }, session })
        .toArray()).map((agent) => agent._id);

      await db.collection<AgentDoc>("agents").deleteMany({ userId }, { session });
      await db.collection<ConversationDoc>("conversations").deleteMany({ userId }, { session });
      await db.collection<ProviderDoc>("providers").deleteMany({ userId }, { session });
      await db.collection<MarketAgentDoc>("market_agents").deleteMany({ ownerUserId: userId }, { session });
      await db.collection<RedemptionDoc>("redemptions").deleteMany({ userId }, { session });
      await db.collection<UsageLogDoc>("usage_logs").deleteMany({ userId }, { session });
      await db.collection<{ _id: string }>("avatar_locks").deleteMany({
        _id: { $in: [`user:${userId}`, ...agentIds.map((agentId) => `agent:${agentId}`)] },
      }, { session });
      await db.collection<UserDoc>("users").deleteOne({ _id: userId }, { session });
    });
  } finally {
    await session.endSession();
  }

  return { agentIds, marketAgentIds };
}

export async function bumpSyncVersion(userId: string, session?: ClientSession): Promise<number> {
  const db = await getDb();
  const user = await db.collection<UserDoc>("users").findOneAndUpdate(
    { _id: userId },
    { $inc: { syncVersion: 1 } },
    { returnDocument: "after", includeResultMetadata: false, session },
  );
  if (!user) {
    throw new NotFoundError("User not found.");
  }
  return user.syncVersion;
}

async function withVersionedWrite(
  userId: string,
  mutation: (version: number, session: ClientSession) => Promise<void>,
): Promise<number> {
  const client = await getMongoClient();
  const session = client.startSession();
  let version: number | null = null;

  try {
    await session.withTransaction(async () => {
      version = await bumpSyncVersion(userId, session);
      await mutation(version, session);
    });
  } finally {
    await session.endSession();
  }

  if (version === null) {
    throw new Error("The versioned write did not commit.");
  }
  return version;
}

async function getSyncVersion(userId: string): Promise<number> {
  const db = await getDb();
  const user = await db.collection<UserDoc>("users").findOne(
    { _id: userId },
    { projection: { syncVersion: 1 } },
  );
  if (!user) {
    throw new NotFoundError("User not found.");
  }
  return user.syncVersion;
}

// 调用方只用到 _id / userId / deleted / version（以及 Agent 的 isDefault /
// avatarUrl / avatarVersion），完整文档里的 messages（最多 10k 条）和
// models 数组从不被读，所以统一投影掉，避免每次 upsert/delete 把整篇
// 大字段从 MongoDB 拉到 serverless 实例。
const OWNERSHIP_PROJECTIONS: Record<"agents" | "conversations" | "providers", Record<string, 0 | 1>> = {
  agents: {
    _id: 1,
    userId: 1,
    isDefault: 1,
    deleted: 1,
    avatarUrl: 1,
    avatarVersion: 1,
    version: 1,
  },
  conversations: { _id: 1, userId: 1, deleted: 1, version: 1 },
  providers: { _id: 1, userId: 1, deleted: 1, version: 1 },
};

async function assertEntityOwnership<T extends { _id: string; userId: string }>(
  collectionName: "agents" | "conversations" | "providers",
  userId: string,
  entityId: string,
  session?: ClientSession,
): Promise<T | null> {
  const db = await getDb();
  const entity = await db.collection<T>(collectionName).findOne(
    { _id: entityId } as Filter<T>,
    { session, projection: OWNERSHIP_PROJECTIONS[collectionName] },
  );
  if (entity && entity.userId !== userId) {
    return null;
  }
  return entity as T | null;
}

async function rejectAdditionalDefaultAgent(
  userId: string,
  agentId: string,
  session?: ClientSession,
): Promise<void> {
  const db = await getDb();
  const otherDefault = await db.collection<AgentDoc>("agents").findOne({
    userId,
    _id: { $ne: agentId },
    isDefault: true,
    deleted: false,
  }, { session });
  if (otherDefault) {
    throw new ConflictError("An account can only have one default agent.");
  }
}

async function requireDefaultAgent(userId: string, session?: ClientSession): Promise<void> {
  const db = await getDb();
  const defaultAgent = await db.collection<AgentDoc>("agents").findOne(
    { userId, isDefault: true, deleted: false },
    { session },
  );
  if (!defaultAgent) {
    throw new ConflictError("An account must have a default agent before adding other agents.");
  }
}

export async function getAgentById(userId: string, agentId: string): Promise<AgentDoc | null> {
  const db = await getDb();
  return db.collection<AgentDoc>("agents").findOne({ _id: agentId, userId });
}

export async function upsertAgent(userId: string, agent: AgentUpsertInput): Promise<number> {
  return withVersionedWrite(userId, async (version, session) => {
    const existing = await assertEntityOwnership<AgentDoc>("agents", userId, agent.id, session);
    if (existing?.isDefault && !agent.isDefault) {
      throw new ConflictError("The default agent cannot be changed to a non-default agent.");
    }
    if (agent.isDefault) {
      await rejectAdditionalDefaultAgent(userId, agent.id, session);
    } else if (!existing?.isDefault) {
      await requireDefaultAgent(userId, session);
    }

    const db = await getDb();
    await db.collection<AgentDoc>("agents").updateOne(
      { _id: agent.id, userId },
      {
        $set: {
          userId,
          name: agent.name,
          avatarUrl: existing?.avatarUrl ?? null,
          avatarVersion: existing?.avatarVersion ?? null,
          systemPrompt: agent.systemPrompt,
          defaultModelId: agent.defaultModelId ?? null,
          temperature: agent.temperature,
          topP: agent.topP,
          maxTokens: agent.maxTokens ?? null,
          reasoningEffort: agent.reasoningEffort ?? null,
          isDefault: agent.isDefault,
          followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
          followDefaultModel: agent.followDefaultModel,
          followDefaultTemperature: agent.followDefaultTemperature,
          followDefaultTopP: agent.followDefaultTopP,
          followDefaultMaxTokens: agent.followDefaultMaxTokens,
          followDefaultReasoningEffort: agent.followDefaultReasoningEffort,
          marketAgentId: agent.marketAgentId ?? null,
          marketAgentVersion: agent.marketAgentVersion ?? null,
          marketAgentRole: agent.marketAgentRole ?? null,
          createdAt: agent.createdAt,
          updatedAt: agent.updatedAt,
          version,
          deleted: false,
        },
      },
      { upsert: true, session },
    );
  });
}

export async function createMarketAgent(userId: string, input: MarketAgentInput): Promise<MarketAgentDoc> {
  const db = await getDb();
  const now = Date.now();
  const agent: MarketAgentDoc = {
    _id: randomUUID(),
    ownerUserId: userId,
    name: input.name,
    avatarUrl: null,
    avatarVersion: null,
    systemPrompt: input.systemPrompt,
    temperature: input.temperature,
    topP: input.topP,
    maxTokens: input.maxTokens ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    createdAt: now,
    updatedAt: now,
    version: 1,
    deleted: false,
  };
  await db.collection<MarketAgentDoc>("market_agents").insertOne(agent);
  return agent;
}

export async function getMarketAgent(id: string): Promise<MarketAgentDoc | null> {
  const db = await getDb();
  return db.collection<MarketAgentDoc>("market_agents").findOne({ _id: id, deleted: false });
}

export async function listMarketAgents(query: string, limit: number, cursor?: string | null): Promise<MarketAgentDoc[]> {
  const db = await getDb();
  const filter: Filter<MarketAgentDoc> = {
    deleted: false,
    ...(query ? { name: { $regex: escapeRegex(query), $options: "i" } } : {}),
  };
  if (cursor) {
    // 游标编码为 base64url(JSON({ updatedAt, id }))，省掉之前每次分页
    // 都要 findOne(_id: cursor) 拿 updatedAt/_id 的一次额外往返。
    const decoded = decodeMarketCursor(cursor);
    if (decoded) {
      filter.$or = [
        { updatedAt: { $lt: decoded.updatedAt } },
        { updatedAt: decoded.updatedAt, _id: { $gt: decoded.id } },
      ];
    }
  }
  return db.collection<MarketAgentDoc>("market_agents")
    .find(filter)
    .sort({ updatedAt: -1, _id: 1 })
    .limit(limit)
    .toArray();
}

export function encodeMarketCursor(updatedAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id })).toString("base64url");
}

export function decodeMarketCursor(cursor: string): { updatedAt: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed.updatedAt !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function updateMarketAgent(userId: string, id: string, input: MarketAgentInput): Promise<MarketAgentDoc> {
  const db = await getDb();
  const now = Date.now();
  const result = await db.collection<MarketAgentDoc>("market_agents").findOneAndUpdate(
    { _id: id, ownerUserId: userId, deleted: false },
    {
      $set: {
        name: input.name,
        systemPrompt: input.systemPrompt,
        temperature: input.temperature,
        topP: input.topP,
        maxTokens: input.maxTokens ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        updatedAt: now,
      },
      $inc: { version: 1 },
    },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!result) throw new NotFoundError("Market Agent not found.");
  return result;
}

export async function updateMarketAgentAvatar(
  userId: string,
  id: string,
  avatarUrl: string | null,
): Promise<MarketAgentDoc> {
  const db = await getDb();
  const result = await db.collection<MarketAgentDoc>("market_agents").findOneAndUpdate(
    { _id: id, ownerUserId: userId, deleted: false },
    { $set: { avatarUrl, avatarVersion: avatarUrl ? Date.now() : null, updatedAt: Date.now() }, $inc: { version: 1 } },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!result) throw new NotFoundError("Market Agent not found.");
  return result;
}

export async function deleteMarketAgent(userId: string, id: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<MarketAgentDoc>("market_agents").updateOne(
    { _id: id, ownerUserId: userId, deleted: false },
    { $set: { deleted: true, updatedAt: Date.now() }, $inc: { version: 1 } },
  );
  if (result.matchedCount !== 1) throw new NotFoundError("Market Agent not found.");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function softDeleteAgent(
  userId: string,
  agentId: string,
  avatarLock?: AvatarLock,
): Promise<number> {
  // 已删除早退：避免重复删除触发新的 syncVersion 递增。
  const existing = await getAgentById(userId, agentId);
  if (existing?.deleted) {
    return existing.version;
  }

  return withVersionedWrite(userId, async (version, session) => {
    if (avatarLock) {
      await renewAvatarLock(avatarLock, session);
    }
    const db = await getDb();
    // 把 isDefault: false 直接放到 filter 里：默认 Agent 不会被匹配，
    // 避免先读后写两次往返。matchedCount=0 时再回退到一次 findOne
    // 给出准确的 404/409 错误。
    const result = await db.collection<AgentDoc>("agents").updateOne(
      { _id: agentId, userId, deleted: false, isDefault: false },
      { $set: { deleted: true, avatarUrl: null, avatarVersion: null, updatedAt: Date.now(), version } },
      { session },
    );
    if (result.matchedCount === 1) {
      return;
    }
    const agent = await db.collection<AgentDoc>("agents").findOne(
      { _id: agentId },
      { projection: { userId: 1, isDefault: 1, deleted: 1 }, session },
    );
    if (!agent || agent.userId !== userId) {
      throw new NotFoundError("Agent not found.");
    }
    if (agent.isDefault) {
      throw new ConflictError("The default agent cannot be deleted.");
    }
    // 此时 agent.deleted 一定为 true：另一个并发请求抢先删除了它。
    // 仍然抛 NotFound 让客户端走幂等重试，因为它本地游标还会再拉到这条墓碑。
    throw new NotFoundError("Agent not found.");
  });
}

export async function updateAgentAvatar(
  userId: string,
  agentId: string,
  avatarUrl: string | null,
  avatarLock?: AvatarLock,
  avatarVersion?: number | null,
): Promise<number> {
  const nextAvatarVersion = avatarUrl ? (avatarVersion ?? Date.now()) : null;
  return withVersionedWrite(userId, async (version, session) => {
    if (avatarLock) {
      await renewAvatarLock(avatarLock, session);
    }
    const agent = await assertEntityOwnership<AgentDoc>("agents", userId, agentId, session);
    if (!agent || agent.deleted) {
      throw new NotFoundError("Agent not found.");
    }

    const db = await getDb();
    const result = await db.collection<AgentDoc>("agents").updateOne(
      { _id: agentId, userId, deleted: false },
      { $set: { avatarUrl, avatarVersion: nextAvatarVersion, updatedAt: Date.now(), version } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new NotFoundError("Agent not found.");
    }
  });
}

export async function listAgentsSince(userId: string, since: number, latestVersion: number): Promise<AgentDoc[]> {
  const db = await getDb();
  return db.collection<AgentDoc>("agents")
    .find({ userId, version: { $gt: since, $lte: latestVersion } })
    .sort({ version: 1, _id: 1 })
    .toArray();
}

export async function upsertConversation(userId: string, conversation: ConversationUpsertInput): Promise<number> {
  return withVersionedWrite(userId, async (version, session) => {
    await assertEntityOwnership<ConversationDoc>("conversations", userId, conversation.id, session);
    const db = await getDb();
    await db.collection<ConversationDoc>("conversations").updateOne(
      { _id: conversation.id, userId },
      {
        $set: {
          userId,
          agentId: conversation.agentId,
          title: conversation.title,
          providerId: conversation.providerId,
          overrideModelId: conversation.overrideModelId ?? null,
          overrideTemperature: conversation.overrideTemperature ?? null,
          overrideTopP: conversation.overrideTopP ?? null,
          overrideMaxTokens: conversation.overrideMaxTokens ?? null,
          overrideReasoningEffort: conversation.overrideReasoningEffort ?? null,
          reasoningFormat: conversation.reasoningFormat ?? null,
          contextSummary: conversation.contextSummary ?? null,
          contextSummaryUntil: conversation.contextSummaryUntil ?? 0,
          contextTokens: conversation.contextTokens ?? 0,
          contextTokensAt: conversation.contextTokensAt ?? 0,
          messages: conversation.messages,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          version,
          deleted: false,
        },
      },
      { upsert: true, session },
    );
  });
}

export async function softDeleteConversation(userId: string, conversationId: string): Promise<number> {
  // 已删除早退：避免重复删除触发新的 syncVersion 递增。
  const existing = await assertEntityOwnership<ConversationDoc>("conversations", userId, conversationId);
  if (!existing) {
    throw new NotFoundError("Conversation not found.");
  }
  if (existing.deleted) {
    return existing.version;
  }

  return withVersionedWrite(userId, async (version, session) => {
    const db = await getDb();
    // 同时清空 messages 数组：墓碑只需要 _id/version/deleted 元数据，
    // 保留 messages 会让 GET /api/sync 在每次会话被删除后仍然回传完整
    // 历史（单文档最多 10k 条消息），无谓地放大同步响应体积。
    // 用 deleted: false 作 filter，已删除文档自然不匹配；matchedCount=0
    // 说明另一个并发请求抢先删除了它 —— 抛 NotFound 让客户端走幂等重试。
    const result = await db.collection<ConversationDoc>("conversations").updateOne(
      { _id: conversationId, userId, deleted: false },
      {
        $set: { deleted: true, updatedAt: Date.now(), version },
        $unset: { messages: "" },
      },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new NotFoundError("Conversation not found.");
    }
  });
}

export async function listConversationsSince(
  userId: string,
  since: number,
  latestVersion: number,
): Promise<ConversationDoc[]> {
  const db = await getDb();
  return db.collection<ConversationDoc>("conversations")
    .find({ userId, version: { $gt: since, $lte: latestVersion } })
    .sort({ version: 1, _id: 1 })
    .toArray();
}

export async function upsertProvider(userId: string, provider: ProviderUpsertInput): Promise<number> {
  return withVersionedWrite(userId, async (version, session) => {
    await assertEntityOwnership<ProviderDoc>("providers", userId, provider.id, session);
    const db = await getDb();
    await db.collection<ProviderDoc>("providers").updateOne(
      { _id: provider.id, userId },
      {
        $set: {
          userId,
          name: provider.name,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          models: provider.models,
          createdAt: provider.createdAt,
          updatedAt: provider.updatedAt,
          version,
          deleted: false,
        },
      },
      { upsert: true, session },
    );
  });
}

export async function softDeleteProvider(userId: string, providerId: string): Promise<number> {
  // 已删除早退：避免重复删除触发新的 syncVersion 递增。
  const existing = await assertEntityOwnership<ProviderDoc>("providers", userId, providerId);
  if (!existing) {
    throw new NotFoundError("Provider not found.");
  }
  if (existing.deleted) {
    return existing.version;
  }

  return withVersionedWrite(userId, async (version, session) => {
    const db = await getDb();
    // 用 deleted: false 作 filter，已删除文档自然不匹配；matchedCount=0
    // 说明另一个并发请求抢先删除了它 —— 抛 NotFound 让客户端走幂等重试。
    const result = await db.collection<ProviderDoc>("providers").updateOne(
      { _id: providerId, userId, deleted: false },
      { $set: { deleted: true, updatedAt: Date.now(), version } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new NotFoundError("Provider not found.");
    }
  });
}

export async function listProvidersSince(userId: string, since: number, latestVersion: number): Promise<ProviderDoc[]> {
  const db = await getDb();
  return db.collection<ProviderDoc>("providers")
    .find({ userId, version: { $gt: since, $lte: latestVersion } })
    .sort({ version: 1, _id: 1 })
    .toArray();
}

export async function updateUserAvatar(
  userId: string,
  avatarUrl: string | null,
  avatarLock?: AvatarLock,
  avatarVersion?: number | null,
): Promise<number> {
  const nextAvatarVersion = avatarUrl ? (avatarVersion ?? Date.now()) : null;
  return withVersionedWrite(userId, async (_version, session) => {
    if (avatarLock) {
      await renewAvatarLock(avatarLock, session);
    }
    const db = await getDb();
    const result = await db.collection<UserDoc>("users").updateOne(
      { _id: userId },
      { $set: { avatarUrl, avatarVersion: nextAvatarVersion, updatedAt: Date.now() } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new NotFoundError("User not found.");
    }
  });
}

export async function getDeltaSince(userId: string, since: number): Promise<SyncResponse> {
  // Read the waterline first, then bound every collection query to that snapshot.
  const latestVersion = await getSyncVersion(userId);
  const [agents, conversations, providers] = await Promise.all([
    listAgentsSince(userId, since, latestVersion),
    listConversationsSince(userId, since, latestVersion),
    listProvidersSince(userId, since, latestVersion),
  ]);
  return { agents, conversations, providers, latestVersion };
}

export type SyncCollection = "agents" | "conversations" | "providers";

export interface SyncPage {
  // 当前页所属集合；客户端拿到 hasMore=true 时应使用同一 collection + nextCursor 继续翻页。
  collection: SyncCollection;
  // 当前页文档（按 version 升序、_id 升序）。已删除的会话在这里只含墓碑字段。
  documents: AgentDoc[] | ConversationDoc[] | ProviderDoc[];
  // 当前集合是否还有更多文档可拉。
  hasMore: boolean;
  // 下一页游标（base64url 编码的 { version, id }）。hasMore=false 时为 null。
  nextCursor: string | null;
  // 当前可见的水位线，客户端应保存为新的 since 游标。
  latestVersion: number;
}

function encodeSyncCursor(version: number, id: string): string {
  return Buffer.from(JSON.stringify({ version, id })).toString("base64url");
}

function decodeSyncCursor(cursor: string): { version: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed.version !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return { version: parsed.version, id: parsed.id };
  } catch {
    return null;
  }
}

export const SYNC_DEFAULT_LIMIT = 100;
export const SYNC_MAX_LIMIT = 500;

/**
 * 按集合分页拉取增量。每个集合单独翻页，避免初始同步把全部历史
 * （含已删除会话的 messages）一次性塞进单个 JSON 响应。
 *
 * 客户端协议：
 *   GET /api/sync?since=N                            -> 旧行为，返回三集合合并响应
 *   GET /api/sync?since=N&collection=conversations&limit=100
 *   GET /api/sync?since=N&collection=conversations&cursor=...
 *
 * 翻完一个集合后客户端应记下 latestVersion，然后切换到下一个集合，
 * 最后把 latestVersion 作为新的 since 保存。
 */
export async function getDeltaSincePaged(
  userId: string,
  since: number,
  collection: SyncCollection,
  cursor?: string | null,
  limit?: number,
): Promise<SyncPage> {
  const pageSize = Math.min(
    Math.max(limit ?? SYNC_DEFAULT_LIMIT, 1),
    SYNC_MAX_LIMIT,
  );
  const latestVersion = await getSyncVersion(userId);
  const db = await getDb();

  // 翻页时 cursor 接管下界，初始请求用 since 作下界；上界始终是 latestVersion。
  const decoded = cursor ? decodeSyncCursor(cursor) : null;
  const filter = decoded
    ? {
        userId,
        version: { $lte: latestVersion },
        $or: [
          { version: { $gt: decoded.version } },
          { version: decoded.version, _id: { $gt: decoded.id } },
        ],
      }
    : { userId, version: { $gt: since, $lte: latestVersion } };

  const cursor_options = { sort: { version: 1, _id: 1 } as const, limit: pageSize + 1 };
  let docs: AgentDoc[] | ConversationDoc[] | ProviderDoc[];
  if (collection === "agents") {
    docs = await db.collection<AgentDoc>("agents").find(filter, cursor_options).toArray();
  } else if (collection === "conversations") {
    docs = await db.collection<ConversationDoc>("conversations").find(filter, cursor_options).toArray();
  } else {
    docs = await db.collection<ProviderDoc>("providers").find(filter, cursor_options).toArray();
  }

  const hasMore = docs.length > pageSize;
  const page = hasMore ? docs.slice(0, pageSize) : docs;
  const last = page.at(-1) as { _id: string; version: number } | undefined;
  const nextCursor = hasMore && last
    ? encodeSyncCursor(last.version, last._id)
    : null;

  return {
    collection,
    documents: page,
    hasMore,
    nextCursor,
    latestVersion,
  };
}

// ---------------------------------------------------------------------------
// SaaS：套餐 / 卡密 / 兑换 / 模型倍率 / 上游 / 用量
// ---------------------------------------------------------------------------

export interface PlanInput {
  name: string;
  description?: string | null;
  quotaTokens: number;
  validityDays: number;
  price?: string | null;
  enabled: boolean;
  sortOrder: number;
}

export async function listPlans(options: { enabledOnly?: boolean } = {}): Promise<PlanDoc[]> {
  const db = await getDb();
  const filter: Filter<PlanDoc> = options.enabledOnly ? { enabled: true } : {};
  return db.collection<PlanDoc>("plans")
    .find(filter)
    .sort({ sortOrder: 1, createdAt: 1, _id: 1 })
    .toArray();
}

export async function getPlanById(planId: string): Promise<PlanDoc | null> {
  const db = await getDb();
  return db.collection<PlanDoc>("plans").findOne({ _id: planId });
}

export async function createPlan(input: PlanInput): Promise<PlanDoc> {
  const db = await getDb();
  const now = Date.now();
  const plan: PlanDoc = {
    _id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    quotaTokens: input.quotaTokens,
    validityDays: input.validityDays,
    price: input.price ?? null,
    enabled: input.enabled,
    sortOrder: input.sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<PlanDoc>("plans").insertOne(plan);
  return plan;
}

export async function updatePlan(planId: string, input: PlanInput): Promise<PlanDoc> {
  const db = await getDb();
  const updated = await db.collection<PlanDoc>("plans").findOneAndUpdate(
    { _id: planId },
    {
      $set: {
        name: input.name,
        description: input.description ?? null,
        quotaTokens: input.quotaTokens,
        validityDays: input.validityDays,
        price: input.price ?? null,
        enabled: input.enabled,
        sortOrder: input.sortOrder,
        updatedAt: Date.now(),
      },
    },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!updated) {
    throw new NotFoundError("Plan not found.");
  }
  return updated;
}

export async function deletePlan(planId: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<PlanDoc>("plans").deleteOne({ _id: planId });
  if (result.deletedCount !== 1) {
    throw new NotFoundError("Plan not found.");
  }
}

export interface CardIssueInput {
  planId: string;
  count: number;
  note?: string | null;
  createdByUserId: string;
}

/**
 * 批量开卡。卡密内嵌创建时刻的套餐快照（名称/额度/有效天数），
 * 因此套餐之后被修改或删除，已发出的卡密仍按开出时的内容兑换。
 */
export async function issueCards(input: CardIssueInput): Promise<CardKeyDoc[]> {
  const plan = await getPlanById(input.planId);
  if (!plan) {
    throw new NotFoundError("Plan not found.");
  }

  const db = await getDb();
  const collection = db.collection<CardKeyDoc>("card_keys");
  const now = Date.now();
  const issued: CardKeyDoc[] = [];

  for (let i = 0; i < input.count; i++) {
    let card: CardKeyDoc | null = null;
    // 卡密编码空间足够大，重复碰撞重试几次即可。
    for (let attempt = 0; attempt < 5 && !card; attempt++) {
      card = {
        _id: randomUUID(),
        code: generateCardCode(),
        planId: plan._id,
        planName: plan.name,
        quotaTokens: plan.quotaTokens,
        validityDays: plan.validityDays,
        status: "unused",
        note: input.note ?? null,
        createdByUserId: input.createdByUserId,
        createdAt: now,
        redeemedByUserId: null,
        redeemedAt: null,
      };
      try {
        await collection.insertOne(card);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          card = null;
          continue;
        }
        throw error;
      }
    }
    if (!card) {
      throw new Error("Unable to generate a unique card code after multiple attempts.");
    }
    issued.push(card);
  }
  return issued;
}

export const CARD_LIST_PAGE_SIZE = 50;

export interface CardListOptions {
  status?: CardKeyStatus;
  planId?: string;
  cursor?: string | null;
  limit?: number;
}

export interface CardListPage {
  cards: CardKeyDoc[];
  hasMore: boolean;
  nextCursor: string | null;
}

function encodeCardCursor(createdAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString("base64url");
}

function decodeCardCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function listCards(options: CardListOptions = {}): Promise<CardListPage> {
  const db = await getDb();
  const limit = Math.min(Math.max(options.limit ?? CARD_LIST_PAGE_SIZE, 1), 200);
  const filter: Filter<CardKeyDoc> = {};
  if (options.status) {
    filter.status = options.status;
  }
  if (options.planId) {
    filter.planId = options.planId;
  }
  const decoded = options.cursor ? decodeCardCursor(options.cursor) : null;
  if (decoded) {
    filter.$or = [
      { createdAt: { $lt: decoded.createdAt } },
      { createdAt: decoded.createdAt, _id: { $lt: decoded.id } },
    ];
  }

  const docs = await db.collection<CardKeyDoc>("card_keys")
    .find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const last = page.at(-1);
  return {
    cards: page,
    hasMore,
    nextCursor: hasMore && last ? encodeCardCursor(last.createdAt, last._id) : null,
  };
}

export async function disableCard(cardId: string): Promise<CardKeyDoc> {
  const db = await getDb();
  const updated = await db.collection<CardKeyDoc>("card_keys").findOneAndUpdate(
    { _id: cardId, status: "unused" },
    { $set: { status: "disabled" } },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!updated) {
    // 区分 404 与「已被兑换」两种失败。
    const existing = await db.collection<CardKeyDoc>("card_keys").findOne({ _id: cardId });
    if (!existing) {
      throw new NotFoundError("Card key not found.");
    }
    throw new ConflictError("Only unused card keys can be disabled.");
  }
  return updated;
}

export async function deleteCard(cardId: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<CardKeyDoc>("card_keys").deleteOne({
    _id: cardId,
    status: { $in: ["unused", "disabled"] },
  });
  if (result.deletedCount !== 1) {
    const existing = await db.collection<CardKeyDoc>("card_keys").findOne({ _id: cardId });
    if (!existing) {
      throw new NotFoundError("Card key not found.");
    }
    throw new ConflictError("Redeemed card keys cannot be deleted.");
  }
}

/** 用户全部套餐条目的轻量视图（balance / expiresAt），供汇总计算。 */
async function activeQuotaEntitlements(
  db: Db,
  userId: string,
  session?: ClientSession,
): Promise<QuotaEntitlementView[]> {
  const docs = await db.collection<UserQuotaDoc>("user_quotas")
    .find({ userId }, { session, projection: { balance: 1, expiresAt: 1 } })
    .limit(1_000)
    .toArray();
  return docs.map((doc) => ({ balance: doc.balance ?? 0, expiresAt: doc.expiresAt ?? null }));
}

/** 用户当前可用额度状态（未过期条目汇总）。 */
export async function getUserQuotaState(userId: string): Promise<QuotaState> {
  const db = await getDb();
  return quotaStateFromEntitlements(await activeQuotaEntitlements(db, userId));
}

/** 用户持有的全部套餐条目（管理端详情页用），按获得时间降序。 */
export async function listUserQuotaEntitlements(userId: string, limit = 200): Promise<UserQuotaDoc[]> {
  const db = await getDb();
  return db.collection<UserQuotaDoc>("user_quotas")
    .find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(limit, 1), 1_000))
    .toArray();
}

export interface GrantQuotaInput {
  amount: number;
  /** 不传或 0 = 不限有效期。 */
  validDays?: number;
  source: UserQuotaDoc["source"];
  cardKeyId?: string | null;
  planId?: string | null;
  planName?: string | null;
}

/** 授予一条独立的套餐条目（额度与有效期随条目各自计算）。 */
export async function grantUserQuota(userId: string, input: GrantQuotaInput): Promise<UserQuotaDoc> {
  if (!(input.amount > 0)) {
    throw new Error("Grant amount must be positive.");
  }
  const db = await getDb();
  const now = Date.now();
  const entitlement: UserQuotaDoc = {
    _id: randomUUID(),
    userId,
    source: input.source,
    cardKeyId: input.cardKeyId ?? null,
    planId: input.planId ?? null,
    planName: input.planName ?? null,
    balance: input.amount,
    expiresAt: input.validDays && input.validDays > 0 ? now + input.validDays * DAY_MS : null,
    createdAt: now,
  };
  await db.collection<UserQuotaDoc>("user_quotas").insertOne(entitlement);
  return entitlement;
}

/**
 * 按先过期先用扣减额度（事务内逐条原子扣减）：有限期条目按到期时间升序，
 * 不限期条目最后消耗。返回实际扣减量（不足时扣到 0 为止，不产生负数）。
 */
export async function deductUserQuota(userId: string, amount: number): Promise<number> {
  if (amount <= 0) {
    return 0;
  }
  const db = await getDb();
  const client = await getMongoClient();
  const session = client.startSession();
  let deducted = 0;
  try {
    await session.withTransaction(async () => {
      const now = Date.now();
      const docs = await db.collection<UserQuotaDoc>("user_quotas")
        .find(
          { userId, balance: { $gt: 0 }, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
          { session },
        )
        .toArray();
      docs.sort((a, b) => {
        const expiryA = a.expiresAt ?? Number.MAX_SAFE_INTEGER;
        const expiryB = b.expiresAt ?? Number.MAX_SAFE_INTEGER;
        return expiryA !== expiryB ? expiryA - expiryB : a.createdAt - b.createdAt;
      });
      let remaining = amount;
      for (const doc of docs) {
        if (remaining <= 0) {
          break;
        }
        const take = Math.min(remaining, doc.balance);
        if (take <= 0) {
          continue;
        }
        await db.collection<UserQuotaDoc>("user_quotas").updateOne(
          { _id: doc._id },
          { $set: { balance: doc.balance - take } },
          { session },
        );
        remaining -= take;
        deducted += take;
      }
    });
  } finally {
    await session.endSession();
  }
  return deducted;
}

export interface RedeemResult {
  card: CardKeyDoc;
  redemption: RedemptionDoc;
  /** 兑换后的可用额度汇总（未过期条目之和 / 最晚到期时间）。 */
  quota: QuotaState;
}

/**
 * 卡密兑换。原子占卡（status: unused → redeemed，唯一码 + 状态过滤），
 * 再在同一事务内插入一条独立的套餐条目（额度与有效期随卡各自计算）
 * 并写入兑换记录。
 */
export async function redeemCard(userId: string, rawCode: string): Promise<RedeemResult> {
  const code = normalizeCardCode(rawCode);
  const client = await getMongoClient();
  const session = client.startSession();
  let result: RedeemResult | null = null;

  try {
    await session.withTransaction(async () => {
      const db = await getDb();
      const now = Date.now();
      const card = await db.collection<CardKeyDoc>("card_keys").findOneAndUpdate(
        { code, status: "unused" },
        { $set: { status: "redeemed", redeemedByUserId: userId, redeemedAt: now } },
        { session, returnDocument: "after", includeResultMetadata: false },
      );
      if (!card) {
        const existing = await db.collection<CardKeyDoc>("card_keys").findOne({ code }, { session });
        if (!existing) {
          throw new NotFoundError("卡密不存在，请检查输入是否正确。");
        }
        if (existing.status === "redeemed") {
          throw new ConflictError("该卡密已被使用。");
        }
        throw new ConflictError("该卡密已被停用。");
      }

      const user = await db.collection<UserDoc>("users").findOne({ _id: userId }, { session });
      if (!user) {
        throw new NotFoundError("User not found.");
      }

      const entitlement: UserQuotaDoc = {
        _id: randomUUID(),
        userId,
        source: "card",
        cardKeyId: card._id,
        planId: card.planId,
        planName: card.planName,
        balance: card.quotaTokens,
        expiresAt: now + card.validityDays * 24 * 60 * 60 * 1000,
        createdAt: now,
      };
      await db.collection<UserQuotaDoc>("user_quotas").insertOne(entitlement, { session });

      const redemption: RedemptionDoc = {
        _id: randomUUID(),
        userId,
        cardKeyId: card._id,
        cardCode: card.code,
        planId: card.planId,
        planName: card.planName,
        quotaTokens: card.quotaTokens,
        validityDays: card.validityDays,
        createdAt: now,
      };
      await db.collection<RedemptionDoc>("redemptions").insertOne(redemption, { session });
      result = { card, redemption, quota: quotaStateFromEntitlements(await activeQuotaEntitlements(db, userId, session)) };
    });
  } finally {
    await session.endSession();
  }

  if (result === null) {
    throw new Error("The redemption transaction did not commit.");
  }
  return result;
}

/**
 * 兑换前查询卡密信息（不消费）。卡内嵌创建时的套餐快照，
 * 与 redeemCard 使用同一套状态与错误文案，预览通过即可兑换。
 */
export async function previewCard(rawCode: string): Promise<CardKeyDoc> {
  const code = normalizeCardCode(rawCode);
  const db = await getDb();
  const card = await db.collection<CardKeyDoc>("card_keys").findOne({ code });
  if (!card) {
    throw new NotFoundError("卡密不存在，请检查输入是否正确。");
  }
  if (card.status !== "unused") {
    throw new ConflictError(card.status === "redeemed" ? "该卡密已被使用。" : "该卡密已被停用。");
  }
  return card;
}

export async function listRedemptions(userId: string, limit = 50): Promise<RedemptionDoc[]> {
  const db = await getDb();
  return db.collection<RedemptionDoc>("redemptions")
    .find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .toArray();
}

export async function updateUserAiApiKey(userId: string, apiKey: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<UserDoc>("users").updateOne(
    { _id: userId },
    { $set: { aiApiKey: apiKey, updatedAt: Date.now() } },
  );
  if (result.matchedCount !== 1) {
    throw new NotFoundError("User not found.");
  }
}

export async function listUsers(limit = 200): Promise<AdminUserView[]> {
  const db = await getDb();
  const now = Date.now();
  const [users, quotaRows] = await Promise.all([
    db.collection<UserDoc>("users")
      .find({}, { projection: { email: 1, role: 1, createdAt: 1, lastLoginAt: 1 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(Math.max(limit, 1), 1_000))
      .toArray(),
    db.collection<UserQuotaDoc>("user_quotas").aggregate<{
      _id: string;
      balance: number;
      count: number;
      unlimited: number;
      maxExpiry?: number;
    }>([
      { $match: { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] } },
      {
        $group: {
          _id: "$userId",
          balance: { $sum: "$balance" },
          count: { $sum: 1 },
          unlimited: { $max: { $cond: [{ $eq: ["$expiresAt", null] }, 1, 0] } },
          maxExpiry: { $max: "$expiresAt" },
        },
      },
    ]).toArray(),
  ]);
  const quotaByUser = new Map(quotaRows.map((row) => [row._id, row]));
  return users.map((user) => {
    const quota = quotaByUser.get(user._id);
    const unlimited = (quota?.unlimited ?? 0) === 1;
    return {
      _id: user._id,
      email: user.email,
      role: user.role ?? "user",
      quotaBalance: quota?.balance ?? 0,
      quotaExpiresAt: unlimited ? null : quota?.maxExpiry ?? null,
      quotaUnlimited: unlimited,
      activeQuotaCount: quota?.count ?? 0,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  });
}

export interface AdminUserPatch {
  /** 额度增减（正数充值 / 负数扣减），结果下限 0。 */
  quotaDelta?: number;
  /** 充值条目的有效天数（0 = 不限），仅 quotaDelta > 0 时生效。 */
  quotaValidDays?: number;
  /** 有效期顺延天数，作用于所有已设到期时间的未过期条目。 */
  quotaExtendDays?: number;
  role?: UserRole;
}

/**
 * 管理员修改用户（角色 / 额度 / 有效期）。禁止修改自己的角色，
 * 避免误操作把唯一管理员降级导致锁死。额度操作作用于独立的套餐条目：
 * 正数充值生成新条目（可设有效天数，0 = 不限），负数按先过期先用扣减，
 * 顺延天数作用于所有已设到期时间的未过期条目（不限期条目保持不限）。
 */
export async function adminUpdateUser(
  operatorId: string,
  userId: string,
  patch: AdminUserPatch,
): Promise<AdminUserView> {
  const db = await getDb();
  const user = await db.collection<UserDoc>("users").findOne({ _id: userId });
  if (!user) {
    throw new NotFoundError("User not found.");
  }
  if (patch.role !== undefined && patch.role !== user.role && userId === operatorId) {
    throw new ConflictError("不能修改自己的角色。");
  }

  const now = Date.now();
  if (patch.quotaDelta !== undefined && patch.quotaDelta > 0) {
    await grantUserQuota(userId, {
      amount: patch.quotaDelta,
      validDays: patch.quotaValidDays,
      source: "admin",
    });
  } else if (patch.quotaDelta !== undefined && patch.quotaDelta < 0) {
    await deductUserQuota(userId, -patch.quotaDelta);
  }
  if (patch.quotaExtendDays !== undefined && patch.quotaExtendDays > 0) {
    await db.collection<UserQuotaDoc>("user_quotas").updateMany(
      { userId, expiresAt: { $ne: null, $gt: now } },
      { $inc: { expiresAt: patch.quotaExtendDays * DAY_MS } },
    );
  }
  if (patch.role !== undefined) {
    await db.collection<UserDoc>("users").updateOne(
      { _id: userId },
      { $set: { role: patch.role, updatedAt: now } },
    );
  }

  const entitlements = await activeQuotaEntitlements(db, userId);
  const state = quotaStateFromEntitlements(entitlements);
  const activeCount = entitlements.filter((entry) => entry.expiresAt === null || entry.expiresAt > Date.now()).length;
  return {
    _id: user._id,
    email: user.email,
    role: patch.role ?? user.role ?? "user",
    quotaBalance: state.balance,
    quotaExpiresAt: state.expiresAt,
    quotaUnlimited: state.available && state.expiresAt === null,
    activeQuotaCount: activeCount,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}



export interface UpstreamInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  modelMeta?: Record<string, UpstreamModelMeta> | null;
  priority: number;
  enabled: boolean;
}

function normalizeUpstreamModelMeta(
  modelMeta: Record<string, UpstreamModelMeta> | null | undefined,
): Record<string, UpstreamModelMeta> | null {
  if (!modelMeta) {
    return null;
  }
  const normalized: Record<string, UpstreamModelMeta> = {};
  for (const [modelId, meta] of Object.entries(modelMeta)) {
    const id = modelId.trim();
    if (!id || !meta) continue;
    const entry: UpstreamModelMeta = {};
    if (typeof meta.override === 'boolean') {
      entry.override = meta.override;
    }
    if (typeof meta.contextWindow === 'number' && Number.isFinite(meta.contextWindow) && meta.contextWindow >= 0) {
      entry.contextWindow = Math.round(meta.contextWindow);
    }
    if (typeof meta.inputRate === 'number' && Number.isFinite(meta.inputRate) && meta.inputRate >= 0) {
      entry.inputRate = meta.inputRate;
    }
    if (typeof meta.outputRate === 'number' && Number.isFinite(meta.outputRate) && meta.outputRate >= 0) {
      entry.outputRate = meta.outputRate;
    }
    if (Object.keys(entry).length > 0) {
      normalized[id] = entry;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeUpstreamModels(models: string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}

export async function listUpstreams(): Promise<UpstreamDoc[]> {
  const db = await getDb();
  return db.collection<UpstreamDoc>("upstreams")
    .find({})
    .sort({ priority: 1, createdAt: 1, _id: 1 })
    .toArray();
}

export async function listUpstreamsForModel(modelId: string): Promise<UpstreamDoc[]> {
  const db = await getDb();
  return db.collection<UpstreamDoc>("upstreams")
    .find({ enabled: true, models: modelId })
    .sort({ priority: 1, createdAt: 1, _id: 1 })
    .toArray();
}

export async function getUpstreamById(upstreamId: string): Promise<UpstreamDoc | null> {
  const db = await getDb();
  return db.collection<UpstreamDoc>("upstreams").findOne({ _id: upstreamId });
}

export async function createUpstream(input: UpstreamInput): Promise<UpstreamDoc> {
  const db = await getDb();
  const now = Date.now();
  const upstream: UpstreamDoc = {
    _id: randomUUID(),
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: normalizeUpstreamModels(input.models),
    modelMeta: normalizeUpstreamModelMeta(input.modelMeta),
    priority: input.priority,
    enabled: input.enabled,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection<UpstreamDoc>("upstreams").insertOne(upstream);
  return upstream;
}

export async function updateUpstream(upstreamId: string, input: UpstreamInput): Promise<UpstreamDoc> {
  const db = await getDb();
  const updated = await db.collection<UpstreamDoc>("upstreams").findOneAndUpdate(
    { _id: upstreamId },
    {
      $set: {
        name: input.name,
        baseUrl: input.baseUrl,
        apiKey: input.apiKey,
        models: normalizeUpstreamModels(input.models),
        modelMeta: normalizeUpstreamModelMeta(input.modelMeta),
        priority: input.priority,
        enabled: input.enabled,
        updatedAt: Date.now(),
      },
    },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!updated) {
    throw new NotFoundError("Upstream not found.");
  }
  return updated;
}

export async function deleteUpstream(upstreamId: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<UpstreamDoc>("upstreams").deleteOne({ _id: upstreamId });
  if (result.deletedCount !== 1) {
    throw new NotFoundError("Upstream not found.");
  }
}

/** AI API 可对外提供的模型 = 所有启用上游可服务模型的并集。 */
export async function listEnabledUpstreamModels(): Promise<string[]> {
  const db = await getDb();
  const upstreams = await db.collection<UpstreamDoc>("upstreams")
    .find({ enabled: true }, { projection: { models: 1 } })
    .toArray();
  return [...new Set(upstreams.flatMap((upstream) => upstream.models))].sort((a, b) => a.localeCompare(b));
}

/** 全部启用的上游文档（含 modelMeta），供模型广场做倍率聚合。 */
export async function listEnabledUpstreams(): Promise<UpstreamDoc[]> {
  const db = await getDb();
  return db.collection<UpstreamDoc>("upstreams")
    .find({ enabled: true })
    .sort({ priority: 1, _id: 1 })
    .toArray();
}

export async function recordUsage(log: Omit<UsageLogDoc, "_id" | "createdAt">, createdAt?: number): Promise<void> {
  const db = await getDb();
  await db.collection<UsageLogDoc>("usage_logs").insertOne({ ...log, _id: randomUUID(), createdAt: createdAt ?? Date.now() });
}

export async function listUsageLogs(userId: string, limit = 10): Promise<UsageLogDoc[]> {
  const db = await getDb();
  return db.collection<UsageLogDoc>("usage_logs")
    .find({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .toArray();
}

export async function listRecentUsage(limit = 10): Promise<UsageLogDoc[]> {
  const db = await getDb();
  return db.collection<UsageLogDoc>("usage_logs")
    .find({})
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .toArray();
}

export async function sumUsage(userId: string | null, sinceTs: number): Promise<UsageStats> {
  const db = await getDb();
  const pipeline: Record<string, unknown>[] = [
    { $match: { createdAt: { $gte: sinceTs }, ...(userId ? { userId } : {}) } },
    {
      $group: {
        _id: null,
        requests: { $sum: 1 },
        tokens: { $sum: "$totalTokens" },
        cost: { $sum: "$cost" },
      },
    },
  ];
  const rows = await db.collection<UsageLogDoc>("usage_logs").aggregate(pipeline).toArray();
  const row = rows[0] as { requests?: number; tokens?: number; cost?: number } | undefined;
  return {
    requests: row?.requests ?? 0,
    tokens: row?.tokens ?? 0,
    cost: row?.cost ?? 0,
  };
}

/**
 * 扣减额度（AI 计费）。按先过期先用从用户的套餐条目中扣减，
 * 事务内原子完成，余额不足时扣到 0 为止，不产生负数。
 */
export async function consumeQuota(userId: string, cost: number): Promise<void> {
  await deductUserQuota(userId, cost);
}

/** 单个用户的 Messenger Sync 概览：活跃实体计数 + 消息总数 + 最近同步时间。 */
export async function getUserSyncSummary(userId: string): Promise<SyncSummary> {
  const db = await getDb();
  const countStage = { $match: { userId, deleted: false } };
  const groupBase = { _id: null, count: { $sum: 1 }, last: { $max: "$updatedAt" } };
  const [agents, conversations, providers] = await Promise.all([
    db.collection<AgentDoc>("agents").aggregate<{ count: number; last: number | null }>([
      countStage,
      { $group: groupBase },
    ]).next(),
    db.collection<ConversationDoc>("conversations").aggregate<{
      count: number;
      last: number | null;
      messages: number;
    }>([
      countStage,
      {
        $group: {
          ...groupBase,
          messages: { $sum: { $size: { $ifNull: ["$messages", []] } } },
        },
      },
    ]).next(),
    db.collection<ProviderDoc>("providers").aggregate<{ count: number; last: number | null }>([
      countStage,
      { $group: groupBase },
    ]).next(),
  ]);
  const lastSyncAt = [agents?.last, conversations?.last, providers?.last]
    .filter((value): value is number => typeof value === "number");
  return {
    agents: agents?.count ?? 0,
    conversations: conversations?.count ?? 0,
    providers: providers?.count ?? 0,
    messages: conversations?.messages ?? 0,
    lastSyncAt: lastSyncAt.length ? Math.max(...lastSyncAt) : null,
  };
}

/** 全站 Messenger Sync 概览：活跃实体总量 + 有同步数据的用户数。 */
export async function getSyncOverview(): Promise<SiteSyncOverview> {
  const db = await getDb();
  const [agents, conversations, providers] = await Promise.all([
    db.collection<AgentDoc>("agents").aggregate<{ count: number; last: number | null; users: string[] }>([
      { $match: { deleted: false } },
      { $group: { _id: null, count: { $sum: 1 }, last: { $max: "$updatedAt" }, users: { $addToSet: "$userId" } } },
    ]).next(),
    db.collection<ConversationDoc>("conversations").aggregate<{
      count: number;
      last: number | null;
      messages: number;
      users: string[];
    }>([
      { $match: { deleted: false } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          last: { $max: "$updatedAt" },
          messages: { $sum: { $size: { $ifNull: ["$messages", []] } } },
          users: { $addToSet: "$userId" },
        },
      },
    ]).next(),
    db.collection<ProviderDoc>("providers").aggregate<{ count: number; last: number | null; users: string[] }>([
      { $match: { deleted: false } },
      { $group: { _id: null, count: { $sum: 1 }, last: { $max: "$updatedAt" }, users: { $addToSet: "$userId" } } },
    ]).next(),
  ]);
  const syncUsers = new Set<string>([
    ...(agents?.users ?? []),
    ...(conversations?.users ?? []),
    ...(providers?.users ?? []),
  ]);
  const lastValues = [agents?.last, conversations?.last, providers?.last]
    .filter((value): value is number => typeof value === "number");
  return {
    agents: agents?.count ?? 0,
    conversations: conversations?.count ?? 0,
    providers: providers?.count ?? 0,
    messages: conversations?.messages ?? 0,
    lastSyncAt: lastValues.length ? Math.max(...lastValues) : null,
    syncUsers: syncUsers.size,
  };
}

export async function getSiteOverview(): Promise<SiteOverview> {
  const db = await getDb();
  const now = Date.now();
  const dayTs = now - 24 * 60 * 60 * 1000;
  const weekTs = now - 7 * 24 * 60 * 60 * 1000;
  const users = db.collection<UserDoc>("users");
  const cardKeys = db.collection<CardKeyDoc>("card_keys");

  const [
    totalUsers,
    admins,
    newUsers,
    usageToday,
    usageWeek,
    unusedCards,
    redeemedCards,
    disabledCards,
    totalCards,
    totalPlans,
    enabledPlans,
    totalUpstreams,
    enabledUpstreams,
    recentUsers,
    recentUsage,
  ] = await Promise.all([
    users.estimatedDocumentCount(),
    users.countDocuments({ role: "admin" }),
    users.countDocuments({ createdAt: { $gte: dayTs } }),
    sumUsage(null, dayTs),
    sumUsage(null, weekTs),
    cardKeys.countDocuments({ status: "unused" }),
    cardKeys.countDocuments({ status: "redeemed" }),
    cardKeys.countDocuments({ status: "disabled" }),
    cardKeys.estimatedDocumentCount(),
    db.collection<PlanDoc>("plans").estimatedDocumentCount(),
    db.collection<PlanDoc>("plans").countDocuments({ enabled: true }),
    db.collection<UpstreamDoc>("upstreams").estimatedDocumentCount(),
    db.collection<UpstreamDoc>("upstreams").countDocuments({ enabled: true }),
    users.find({}, { projection: { email: 1, role: 1, createdAt: 1 } })
      .sort({ createdAt: -1, _id: -1 }).limit(5).toArray(),
    listRecentUsage(10),
  ]);

  const recent: AdminRecentUser[] = recentUsers.map((user) => ({
    id: user._id,
    email: user.email,
    role: user.role ?? "user",
    createdAt: user.createdAt,
  }));

  return {
    users: { total: totalUsers, admins, newToday: newUsers },
    usage: { today: usageToday, week: usageWeek },
    cards: { total: totalCards, unused: unusedCards, redeemed: redeemedCards, disabled: disabledCards },
    plans: { total: totalPlans, enabled: enabledPlans },
    upstreams: { total: totalUpstreams, enabled: enabledUpstreams },
    recentUsers: recent,
    recentUsage,
  };
}
