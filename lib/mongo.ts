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
import { Db, MongoClient } from "mongodb";
import { generateAiApiKey } from "@/lib/apikeys";
import { env } from "@/lib/env";
import { createLogger } from "@/lib/runtime-logs";
import type { UserQuotaDoc } from "@/lib/types";

declare global {
  var messengerMongoClientPromise: Promise<MongoClient> | undefined;
  var messengerMongoIndexesPromise: Promise<void> | undefined;
}

/** 迁移/启动域日志器（source="migration"）。 */
const migrationLog = createLogger("migration");

export function getMongoClient(): Promise<MongoClient> {
  if (!globalThis.messengerMongoClientPromise) {
    // Serverless 实例规格小、并发请求数低，10 个连接会让驱动预热一堆
    // 用不上的连接，还可能在冷实例上拖慢启动。3 个足够覆盖正常并发；
    // maxIdleTimeMS 让空闲连接尽快归还给 Atlas，避免 Vercel 函数冻结后
    // 还残留半死的 TCP；connectTimeoutMS 防止冷启动时卡在 DNS/TLS。
    const client = new MongoClient(env.mongoUri(), {
      maxPoolSize: 3,
      maxIdleTimeMS: 30_000,
      connectTimeoutMS: 5_000,
      serverSelectionTimeoutMS: 5_000,
    });
    globalThis.messengerMongoClientPromise = client.connect().catch((error: unknown) => {
      migrationLog.error("MongoDB connection failed.", { error: error instanceof Error ? { name: error.name, message: error.message } : error });
      globalThis.messengerMongoClientPromise = undefined;
      throw error;
    });
  }
  return globalThis.messengerMongoClientPromise;
}

/** 运行时日志保留期（TTL 索引驱动）：30 天。 */
const RUNTIME_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60;

async function ensureIndexesFor(database: Db): Promise<void> {
  if (!globalThis.messengerMongoIndexesPromise) {
    const indexes = Promise.all([
      database.collection("users").createIndex({ email: 1 }, { unique: true }),
      database.collection("users").createIndex({ updatedAt: -1, _id: 1 }),
      database.collection("users").createIndex({ aiApiKey: 1 }),
      database.collection("agents").createIndex({ userId: 1, version: 1 }),
      database.collection("agents").createIndex(
        { userId: 1 },
        { unique: true, partialFilterExpression: { isDefault: true, deleted: false } },
      ),
      database.collection("conversations").createIndex({ userId: 1, version: 1 }),
      database.collection("conversations").createIndex({ userId: 1, agentId: 1 }),
      database.collection("providers").createIndex({ userId: 1, version: 1 }),
      // projects 与其它三个同步集合同构：增量同步按 { userId, version }
      // 过滤 + 排序，缺索引时每次同步都会全集合扫描。
      database.collection("projects").createIndex({ userId: 1, version: 1 }),
      database.collection("market_agents").createIndex({ deleted: 1, updatedAt: -1, _id: 1 }),
      database.collection("market_agents").createIndex({ ownerUserId: 1, deleted: 1 }),
      database.collection("avatar_locks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      database.collection("card_keys").createIndex({ code: 1 }, { unique: true }),
      database.collection("card_keys").createIndex({ status: 1, createdAt: -1, _id: 1 }),
      database.collection("card_keys").createIndex({ planId: 1, status: 1 }),
      database.collection("redemptions").createIndex({ userId: 1, createdAt: -1, _id: 1 }),
      database.collection("usage_logs").createIndex({ userId: 1, createdAt: -1, _id: 1 }),
      database.collection("usage_logs").createIndex({ createdAt: -1, _id: 1 }),
      database.collection("user_quotas").createIndex({ userId: 1, expiresAt: 1 }),
      database.collection("runtime_logs").createIndex({ createdAt: -1, _id: 1 }),
      database.collection("runtime_logs").createIndex({ level: 1, createdAt: -1, _id: 1 }),
      database.collection("runtime_logs").createIndex({ source: 1, createdAt: -1, _id: 1 }),
      // 日志采集把每个 console.* 都镜像入库，没有 TTL 会无界增长，
      // 并让管理端 countDocuments + skip 分页随时间线性变慢。
      database.collection("runtime_logs").createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: RUNTIME_LOG_RETENTION_SECONDS },
      ),
      // 限流计数按窗口分文档，窗口过期即应回收。
      database.collection("rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      // 服务端会话是同步进度账本：{ userId, syncCursor } 供「取最旧会话游标」
      // 决定哪些实体墓碑已无人需要；TTL 索引在会话 30 天到期后自动回收。
      database.collection("user_sessions").createIndex({ userId: 1, syncCursor: 1 }),
      database.collection("user_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      // 一次性邮箱令牌：_id 是令牌哈希（唯一性由主键提供），按用户+用途
      // 删除旧令牌需要复合索引；expiresAt 让过期令牌自动回收。
      database.collection("auth_tokens").createIndex({ userId: 1, purpose: 1 }),
      database.collection("auth_tokens").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      // 墓碑清理按 { userId, deleted, version } 过滤并删除，四个同步集合都要。
      database.collection("agents").createIndex({ userId: 1, deleted: 1, version: 1 }),
      database.collection("conversations").createIndex({ userId: 1, deleted: 1, version: 1 }),
      database.collection("providers").createIndex({ userId: 1, deleted: 1, version: 1 }),
      database.collection("projects").createIndex({ userId: 1, deleted: 1, version: 1 }),
    ]).then(() => undefined);
    const startedAt = Date.now();
    globalThis.messengerMongoIndexesPromise = indexes
      .then(() => ensureUserDocumentBackfill(database))
      .then(() => ensureQuotaEntitlementMigration(database))
      .then(() => ensureUsageInputExcludesCacheMigration(database))
      .then(() => {
        migrationLog.info("Indexes and migrations completed.", { durationMs: Date.now() - startedAt });
      })
      .catch((error: unknown) => {
        migrationLog.error("Index/migration setup failed.", { error: error instanceof Error ? { name: error.name, message: error.message } : error });
        globalThis.messengerMongoIndexesPromise = undefined;
        throw error;
      });
  }
  await globalThis.messengerMongoIndexesPromise;
}

interface BootstrapUserDoc {
  _id: string;
  role?: string;
  aiApiKey?: string;
  createdAt: number;
}

interface SystemBootstrapDoc {
  _id: string;
  grantedToUserId: string;
  createdAt: number;
}

/**
 * 存量用户文档的惰性迁移（SaaS 改造前注册的用户没有 role/quota/aiApiKey
 * 字段），随后执行管理员晋升：
 * - role 缺失 → "user"；额度字段缺失 → 0 / null；
 * - aiApiKey 缺失或为空 → 逐个生成（必须唯一随机，不能 updateMany 批量同值）；
 * - 管理员不变量：没有 admin 时把最早注册的用户提升为 admin，并写入
 *   system_bootstrap 标记防止重复迁移（全新部署交给注册事务处理）。
 */
async function ensureUserDocumentBackfill(database: Db): Promise<void> {
  try {
    const users = database.collection<BootstrapUserDoc>("users");
    await users.updateMany({ role: { $exists: false } }, { $set: { role: "user" } });
    await users.updateMany(
      { quotaBalance: { $exists: false } },
      { $set: { quotaBalance: 0, quotaExpiresAt: null } },
    );
    const legacyKeys = await users.find(
      { $or: [{ aiApiKey: { $exists: false } }, { aiApiKey: "" }] },
      { projection: { _id: 1 } },
    ).toArray();
    for (const user of legacyKeys) {
      await users.updateOne({ _id: user._id }, { $set: { aiApiKey: generateAiApiKey() } });
    }
    if (legacyKeys.length > 0) {
      migrationLog.info("Backfilled legacy user documents.", { migration: "user-backfill", legacyKeyCount: legacyKeys.length });
    }

    const admin = await users.findOne({ role: "admin" }, { projection: { _id: 1 } });
    if (admin) {
      return;
    }
    const bootstrapCollection = database.collection<SystemBootstrapDoc>("system_bootstrap");
    const bootstrap = await bootstrapCollection.findOne({ _id: "admin_bootstrap" });
    if (bootstrap) {
      return;
    }
    const earliest = await users.find({}).sort({ createdAt: 1, _id: 1 }).limit(1).next();
    if (!earliest) {
      return;
    }
    await users.updateOne({ _id: earliest._id }, { $set: { role: "admin" } });
    await bootstrapCollection.insertOne({
      _id: "admin_bootstrap",
      grantedToUserId: earliest._id,
      createdAt: Date.now(),
    });
    migrationLog.info("Admin bootstrap promoted earliest user.", { migration: "admin-bootstrap", userId: earliest._id });
  } catch (error) {
    migrationLog.error("Unable to run the user document backfill migration.", { migration: "user-backfill", error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error });
  }
}

interface LegacyQuotaUserDoc {
  _id: string;
  quotaBalance?: number;
  quotaExpiresAt?: number | null;
}

/**
 * 多套餐条目迁移：把旧「单一额度 + 单一有效期」的用户字段转换为一条
 * source="migrated" 的 user_quotas 条目，然后清零旧字段。只在用户还没有
 * 任何条目时执行（迁移中断后重跑不会重复授予，残留旧字段不再被读取）。
 */
async function ensureQuotaEntitlementMigration(database: Db): Promise<void> {
  try {
    const users = database.collection<LegacyQuotaUserDoc>("users");
    const legacy = await users.find(
      {
        $and: [
          { $or: [{ quotaBalance: { $gt: 0 } }, { quotaExpiresAt: { $ne: null, $exists: true } }] },
        ],
      },
      { projection: { quotaBalance: 1, quotaExpiresAt: 1 } },
    ).toArray();
    for (const user of legacy) {
      const balance = user.quotaBalance ?? 0;
      const expiresAt = user.quotaExpiresAt ?? null;
      const quotas = database.collection<UserQuotaDoc>("user_quotas");
      const existing = await quotas.findOne({ userId: user._id }, { projection: { _id: 1 } });
      if (existing) {
        await users.updateOne(
          { _id: user._id },
          { $set: { quotaBalance: 0, quotaExpiresAt: null, updatedAt: Date.now() } },
        );
        continue;
      }
      await quotas.insertOne({
        _id: randomUUID(),
        userId: user._id,
        source: "migrated",
        cardKeyId: null,
        planId: null,
        planName: null,
        balance,
        expiresAt,
        createdAt: Date.now(),
      });
      await users.updateOne(
        { _id: user._id },
        { $set: { quotaBalance: 0, quotaExpiresAt: null, updatedAt: Date.now() } },
      );
    }
    if (legacy.length > 0) {
      migrationLog.info("Migrated legacy quota entitlements.", { migration: "quota-entitlement", legacyUserCount: legacy.length });
    }
  } catch (error) {
    migrationLog.error("Unable to run the quota entitlement migration.", { migration: "quota-entitlement", error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error });
  }
}

interface LegacyUsageLogDoc {
  _id: string;
  promptTokens: number;
  cachedTokens?: number;
}

/**
 * 记账口径迁移：老 `usage_logs` 的 `promptTokens` 是上游报告的提示总量
 * （含缓存命中部分），而新口径只记未命中缓存的输入。这里把老记录改成
 * 新口径（`promptTokens -= cachedTokens`）并打上 `inputExcludesCache`
 * 标记，迁移可重入、不重复扣减；`totalTokens` 保持完整用量不变。
 */
async function ensureUsageInputExcludesCacheMigration(database: Db): Promise<void> {
  try {
    const logs = database.collection<LegacyUsageLogDoc>("usage_logs");
    const result = await logs.updateMany({ inputExcludesCache: { $exists: false } }, [
      {
        $set: {
          promptTokens: {
            $max: [0, { $subtract: ["$promptTokens", { $ifNull: ["$cachedTokens", 0] }] }],
          },
          inputExcludesCache: true,
        },
      },
    ]);
    if (result.modifiedCount > 0) {
      migrationLog.info("Migrated usage input cache accounting.", { migration: "usage-input-excludes-cache", modifiedCount: result.modifiedCount });
    }
  } catch (error) {
    migrationLog.error("Unable to run the usage input migration.", { migration: "usage-input-excludes-cache", error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error });
  }
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  const database = client.db(env.mongoDbName());
  await ensureIndexesFor(database);
  return database;
}

export async function ensureIndexes(): Promise<void> {
  const client = await getMongoClient();
  await ensureIndexesFor(client.db(env.mongoDbName()));
}
