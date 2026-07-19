import { randomUUID } from "node:crypto";
import { type ClientSession, type Filter, MongoServerError } from "mongodb";
import { renewAvatarLock, type AvatarLock } from "@/lib/avatar-locks";
import { getDb, getMongoClient } from "@/lib/mongo";
import type {
  AdminDashboard,
  AgentDoc,
  AgentUpsertInput,
  MarketAgentDoc,
  MarketAgentInput,
  CollectionStats,
  ConversationDoc,
  ConversationUpsertInput,
  ProviderDoc,
  ProviderUpsertInput,
  StoredUser,
  SyncResponse,
  UserDoc,
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

export async function saveUser(user: StoredUser): Promise<number> {
  const client = await getMongoClient();
  const session = client.startSession();
  const defaultAgentId = randomUUID();
  let version: number | null = null;

  try {
    await session.withTransaction(async () => {
      const db = await getDb();
      await db.collection<UserDoc>("users").insertOne({
        _id: user.id,
        email: user.email,
        passwordHash: user.passwordHash,
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
        isDefault: true,
        followDefaultSystemPrompt: false,
        followDefaultModel: false,
        followDefaultTemperature: false,
        followDefaultTopP: false,
        followDefaultMaxTokens: false,
        marketAgentId: null,
        marketAgentVersion: null,
        marketAgentRole: null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        version: nextVersion,
        deleted: false,
      }, { session });
      version = nextVersion;
    });
  } finally {
    await session.endSession();
  }

  if (version === null) {
    throw new Error("The user registration transaction did not commit.");
  }
  return version;
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
          isDefault: agent.isDefault,
          followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
          followDefaultModel: agent.followDefaultModel,
          followDefaultTemperature: agent.followDefaultTemperature,
          followDefaultTopP: agent.followDefaultTopP,
          followDefaultMaxTokens: agent.followDefaultMaxTokens,
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
    const cursorAgent = await db.collection<MarketAgentDoc>("market_agents").findOne({ _id: cursor, deleted: false });
    if (cursorAgent) {
      filter.$or = [
        { updatedAt: { $lt: cursorAgent.updatedAt } },
        { updatedAt: cursorAgent.updatedAt, _id: { $gt: cursorAgent._id } },
      ];
    }
  }
  return db.collection<MarketAgentDoc>("market_agents")
    .find(filter)
    .sort({ updatedAt: -1, _id: 1 })
    .limit(limit)
    .toArray();
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

async function getCollectionStats(collectionName: "users" | "agents" | "conversations" | "providers"): Promise<CollectionStats> {
  const db = await getDb();
  const collection = db.collection<{ updatedAt: number }>(collectionName);
  // estimatedDocumentCount 走集合元数据，O(1)；countDocuments() 走 COLLSCAN，O(N)。
  // 这里的统计只用于 admin 仪表盘展示，无需精确到并发写入瞬间。
  const [count, latest] = await Promise.all([
    collection.estimatedDocumentCount(),
    collection.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
  ]);
  return { count, latestUpdatedAt: latest?.updatedAt ?? null };
}

export const ADMIN_USER_PAGE_SIZE = 50;

export interface AdminDashboardOptions {
  // 由 (updatedAt, _id) 组成的编码游标；为空表示第一页。
  cursor?: string | null;
  limit?: number;
}

function encodeAdminCursor(updatedAt: number, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id })).toString("base64url");
}

function decodeAdminCursor(cursor: string): { updatedAt: number; id: string } | null {
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

export async function getAdminDashboard(options: AdminDashboardOptions = {}): Promise<AdminDashboard> {
  const db = await getDb();
  const limit = Math.min(Math.max(options.limit ?? ADMIN_USER_PAGE_SIZE, 1), 200);
  const filter: Filter<UserDoc> = {};
  if (options.cursor) {
    const decoded = decodeAdminCursor(options.cursor);
    if (decoded) {
      filter.$or = [
        { updatedAt: { $lt: decoded.updatedAt } },
        { updatedAt: decoded.updatedAt, _id: { $gt: decoded.id } },
      ];
    }
  }

  const [users, userStats, agents, conversations, providers] = await Promise.all([
    db.collection<UserDoc>("users")
      .find(filter, { projection: { passwordHash: 0 } })
      .sort({ updatedAt: -1, _id: 1 })
      .limit(limit + 1)
      .toArray(),
    getCollectionStats("users"),
    getCollectionStats("agents"),
    getCollectionStats("conversations"),
    getCollectionStats("providers"),
  ]);

  const hasMore = users.length > limit;
  const page = hasMore ? users.slice(0, limit) : users;
  const lastUser = page.at(-1);
  const nextCursor = hasMore && lastUser
    ? encodeAdminCursor(lastUser.updatedAt, lastUser._id)
    : null;

  return {
    users: page.map((user) => ({
      id: user._id,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      syncVersion: user.syncVersion,
    })),
    stats: { users: userStats, agents, conversations, providers },
    nextCursor,
    hasMore,
  };
}
