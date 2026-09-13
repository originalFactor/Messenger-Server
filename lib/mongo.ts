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
import { Db, MongoClient } from "mongodb";
import { generateAiApiKey } from "@/lib/apikeys";
import { env } from "@/lib/env";
import type { UserQuotaDoc } from "@/lib/types";

declare global {
  var messengerMongoClientPromise: Promise<MongoClient> | undefined;
  var messengerMongoIndexesPromise: Promise<void> | undefined;
}

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
      globalThis.messengerMongoClientPromise = undefined;
      throw error;
    });
  }
  return globalThis.messengerMongoClientPromise;
}

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
      database.collection("user_quotas").createIndex({ userId: 1, createdAt: -1, _id: 1 }),
    ]).then(() => undefined);
    globalThis.messengerMongoIndexesPromise = indexes
      .then(() => ensureUserDocumentBackfill(database))
      .then(() => ensureQuotaEntitlementMigration(database))
      .catch((error: unknown) => {
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
  } catch (error) {
    console.error("Unable to run the user document backfill migration.", error);
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
  } catch (error) {
    console.error("Unable to run the quota entitlement migration.", error);
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
