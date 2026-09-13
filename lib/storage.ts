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
import { type ClientSession, type Filter, MongoServerError } from "mongodb";
import { renewAvatarLock, type AvatarLock } from "@/lib/avatar-locks";
import { generateCardCode, normalizeCardCode } from "@/lib/apikeys";
import { getDb, getMongoClient } from "@/lib/mongo";
import type {
  AdminRecentUser,
  AgentDoc,
  AgentUpsertInput,
  AiModelDoc,
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
  StoredUser,
  SyncResponse,
  UpstreamDoc,
  UsageLogDoc,
  UsageStats,
  UserDoc,
  UserRole,
} from "@/lib/types";

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

export interface RedeemResult {
  card: CardKeyDoc;
  redemption: RedemptionDoc;
  quotaBalance: number;
  quotaExpiresAt: number;
}

/**
 * 卡密兑换。原子占卡（status: unused → redeemed，唯一码 + 状态过滤），
 * 再在同一事务内累加额度并延长有效期，最后写入兑换记录。
 * 有效期语义：从「当前时刻与现有有效期的较大者」起加本套餐天数。
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

      const base = Math.max(now, user.quotaExpiresAt ?? 0);
      const quotaExpiresAt = base + card.validityDays * 24 * 60 * 60 * 1000;
      const quotaBalance = (user.quotaBalance ?? 0) + card.quotaTokens;
      await db.collection<UserDoc>("users").updateOne(
        { _id: userId },
        { $set: { quotaBalance, quotaExpiresAt, updatedAt: now } },
        { session },
      );

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
      result = { card, redemption, quotaBalance, quotaExpiresAt };
    });
  } finally {
    await session.endSession();
  }

  if (result === null) {
    throw new Error("The redemption transaction did not commit.");
  }
  return result;
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

export async function listAiModels(): Promise<AiModelDoc[]> {
  const db = await getDb();
  return db.collection<AiModelDoc>("ai_models").find({}).sort({ _id: 1 }).toArray();
}

export async function getAiModel(modelId: string): Promise<AiModelDoc | null> {
  const db = await getDb();
  return db.collection<AiModelDoc>("ai_models").findOne({ _id: modelId });
}

/** 模型目录导入：已存在的模型保持原倍率，新模型以 1.0 倍率启用；
 * 传入 contextSizes（如来自 models.dev）时为新模型填充上下文窗口，
 * 并回填已存在但上下文为空的模型。 */
export async function importAiModels(
  modelIds: string[],
  contextSizes?: Record<string, number>,
): Promise<AiModelDoc[]> {
  const db = await getDb();
  const now = Date.now();
  const unique = [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
  for (const modelId of unique) {
    try {
      await db.collection<AiModelDoc>("ai_models").insertOne({
        _id: modelId,
        displayName: null,
        rate: 1,
        contextWindow: contextSizes?.[modelId] ?? null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }
  if (contextSizes) {
    for (const modelId of unique) {
      const contextWindow = contextSizes[modelId];
      if (!contextWindow) {
        continue;
      }
      await db.collection<AiModelDoc>("ai_models").updateOne(
        { _id: modelId, contextWindow: null },
        { $set: { contextWindow, updatedAt: Date.now() } },
      );
    }
  }
  if (unique.length === 0) {
    return [];
  }
  return db.collection<AiModelDoc>("ai_models").find({ _id: { $in: unique } }).sort({ _id: 1 }).toArray();
}

export interface AiModelPatch {
  rate?: number;
  enabled?: boolean;
  displayName?: string | null;
  contextWindow?: number | null;
}

export async function updateAiModel(modelId: string, patch: AiModelPatch): Promise<AiModelDoc> {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.rate !== undefined) {
    set.rate = patch.rate;
  }
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
  }
  if (patch.displayName !== undefined) {
    set.displayName = patch.displayName;
  }
  if (patch.contextWindow !== undefined) {
    set.contextWindow = patch.contextWindow;
  }
  const updated = await db.collection<AiModelDoc>("ai_models").findOneAndUpdate(
    { _id: modelId },
    { $set: set },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!updated) {
    throw new NotFoundError("Model not found.");
  }
  return updated;
}

export async function deleteAiModel(modelId: string): Promise<void> {
  const db = await getDb();
  const result = await db.collection<AiModelDoc>("ai_models").deleteOne({ _id: modelId });
  if (result.deletedCount !== 1) {
    throw new NotFoundError("Model not found.");
  }
}

export interface UpstreamInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  priority: number;
  enabled: boolean;
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

/** AI API 可对外提供的模型 = 启用的目录模型 ∩ 至少一个启用上游可服务。 */
export async function listAvailableAiModels(): Promise<AiModelDoc[]> {
  const db = await getDb();
  const upstreams = await db.collection<UpstreamDoc>("upstreams")
    .find({ enabled: true }, { projection: { models: 1 } })
    .toArray();
  const served = new Set(upstreams.flatMap((upstream) => upstream.models));
  const models = await db.collection<AiModelDoc>("ai_models").find({ enabled: true }).sort({ _id: 1 }).toArray();
  return models.filter((model) => served.has(model._id));
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
 * 扣减额度（下限 0）。流水线更新在服务端原子完成，并发的 AI 请求
 * 不会把余额扣成负数。
 */
export async function consumeQuota(userId: string, cost: number): Promise<void> {
  if (cost <= 0) {
    return;
  }
  const db = await getDb();
  await db.collection<UserDoc>("users").updateOne(
    { _id: userId },
    [
      {
        $set: {
          quotaBalance: { $max: [0, { $subtract: ["$quotaBalance", cost] }] },
          updatedAt: Date.now(),
        },
      },
    ],
  );
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
