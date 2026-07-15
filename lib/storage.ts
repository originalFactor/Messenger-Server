import { randomUUID } from "node:crypto";
import { type ClientSession, type Filter, MongoServerError } from "mongodb";
import { renewAvatarLock, type AvatarLock } from "@/lib/avatar-locks";
import { getDb, getMongoClient } from "@/lib/mongo";
import type {
  AdminDashboard,
  AgentDoc,
  AgentUpsertInput,
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

export async function deleteUserAccount(userId: string): Promise<string[]> {
  const client = await getMongoClient();
  const session = client.startSession();
  let agentIds: string[] = [];

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

      await db.collection<AgentDoc>("agents").deleteMany({ userId }, { session });
      await db.collection<ConversationDoc>("conversations").deleteMany({ userId }, { session });
      await db.collection<ProviderDoc>("providers").deleteMany({ userId }, { session });
      await db.collection<{ _id: string }>("avatar_locks").deleteMany({
        _id: { $in: [`user:${userId}`, ...agentIds.map((agentId) => `agent:${agentId}`)] },
      }, { session });
      await db.collection<UserDoc>("users").deleteOne({ _id: userId }, { session });
    });
  } finally {
    await session.endSession();
  }

  return agentIds;
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

async function assertEntityOwnership<T extends { _id: string; userId: string }>(
  collectionName: "agents" | "conversations" | "providers",
  userId: string,
  entityId: string,
  session?: ClientSession,
): Promise<T | null> {
  const db = await getDb();
  const entity = await db.collection<T>(collectionName).findOne(
    { _id: entityId } as Filter<T>,
    { session },
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

export async function softDeleteAgent(
  userId: string,
  agentId: string,
  avatarLock?: AvatarLock,
): Promise<number> {
  const existing = await getAgentById(userId, agentId);
  if (existing?.deleted) {
    return existing.version;
  }

  return withVersionedWrite(userId, async (version, session) => {
    if (avatarLock) {
      await renewAvatarLock(avatarLock, session);
    }
    const agent = await assertEntityOwnership<AgentDoc>("agents", userId, agentId, session);
    if (!agent) {
      throw new NotFoundError("Agent not found.");
    }
    if (agent.isDefault) {
      throw new ConflictError("The default agent cannot be deleted.");
    }

    const db = await getDb();
    const result = await db.collection<AgentDoc>("agents").updateOne(
      { _id: agentId, userId, deleted: false },
      { $set: { deleted: true, avatarUrl: null, updatedAt: Date.now(), version } },
      { session },
    );
    if (result.matchedCount !== 1) {
      throw new NotFoundError("Agent not found.");
    }
  });
}

export async function updateAgentAvatar(
  userId: string,
  agentId: string,
  avatarUrl: string | null,
  avatarLock?: AvatarLock,
): Promise<number> {
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
      { $set: { avatarUrl, updatedAt: Date.now(), version } },
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
  const existing = await assertEntityOwnership<ConversationDoc>("conversations", userId, conversationId);
  if (!existing) {
    throw new NotFoundError("Conversation not found.");
  }
  if (existing.deleted) {
    return existing.version;
  }

  return withVersionedWrite(userId, async (version, session) => {
    const db = await getDb();
    const result = await db.collection<ConversationDoc>("conversations").updateOne(
      { _id: conversationId, userId, deleted: false },
      { $set: { deleted: true, updatedAt: Date.now(), version } },
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
  const existing = await assertEntityOwnership<ProviderDoc>("providers", userId, providerId);
  if (!existing) {
    throw new NotFoundError("Provider not found.");
  }
  if (existing.deleted) {
    return existing.version;
  }

  return withVersionedWrite(userId, async (version, session) => {
    const db = await getDb();
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
): Promise<number> {
  return withVersionedWrite(userId, async (_version, session) => {
    if (avatarLock) {
      await renewAvatarLock(avatarLock, session);
    }
    const db = await getDb();
    const result = await db.collection<UserDoc>("users").updateOne(
      { _id: userId },
      { $set: { avatarUrl, updatedAt: Date.now() } },
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

async function getCollectionStats(collectionName: "users" | "agents" | "conversations" | "providers"): Promise<CollectionStats> {
  const db = await getDb();
  const collection = db.collection<{ updatedAt: number }>(collectionName);
  const [count, latest] = await Promise.all([
    collection.countDocuments(),
    collection.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next(),
  ]);
  return { count, latestUpdatedAt: latest?.updatedAt ?? null };
}

export async function getAdminDashboard(): Promise<AdminDashboard> {
  const db = await getDb();
  const [users, userStats, agents, conversations, providers] = await Promise.all([
    db.collection<UserDoc>("users")
      .find({}, { projection: { passwordHash: 0 } })
      .sort({ updatedAt: -1, _id: 1 })
      .toArray(),
    getCollectionStats("users"),
    getCollectionStats("agents"),
    getCollectionStats("conversations"),
    getCollectionStats("providers"),
  ]);

  return {
    users: users.map((user) => ({
      id: user._id,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt,
      syncVersion: user.syncVersion,
    })),
    stats: { users: userStats, agents, conversations, providers },
  };
}
