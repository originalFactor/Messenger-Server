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

import { Db, MongoClient } from "mongodb";
import { env } from "@/lib/env";

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
    ]).then(() => undefined);
    globalThis.messengerMongoIndexesPromise = indexes
      .then(() => ensureAdminBootstrap(database))
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
  createdAt: number;
}

interface SystemBootstrapDoc {
  _id: string;
  grantedToUserId: string;
  createdAt: number;
}

/**
 * 管理员不变量的惰性迁移：首个注册用户自动晋升 admin。
 * - 全新部署没有任何用户时直接返回，交给注册事务处理；
 * - 既有部署（SaaS 改造前注册的用户都没有 role 字段）把最早注册的
 *   用户提升为 admin，并写入 system_bootstrap 标记防止重复迁移；
 * - 标记存在但找不到 admin（管理员账号被删）同样跳过，由下一次
 *   注册事务重新产生管理员。
 */
async function ensureAdminBootstrap(database: Db): Promise<void> {
  try {
    const users = database.collection<BootstrapUserDoc>("users");
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
    console.error("Unable to run admin bootstrap migration.", error);
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
