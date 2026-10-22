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

import { createHash, randomBytes, randomInt } from "node:crypto";
import { MongoServerError } from "mongodb";
import { getDb } from "@/lib/mongo";

/**
 * 一次性邮箱令牌（`auth_tokens`）：邮箱验证、找回密码、改绑邮箱共用。
 *
 * 库里只存令牌的 SHA-256，不存明文：数据库转储或日志泄漏都无法直接拿来
 * 重置别人的密码。文档 `_id` 就是哈希，所以「取用即删除」是一次单文档
 * 原子操作（`findOneAndDelete`），并发重放只有第一个请求能拿到文档。
 *
 * 每种用途同时只保留一个有效令牌：重新发送会先删掉该用户该用途的旧令牌，
 * 用户点开旧邮件也不会成功。过期由 TTL 索引（`expiresAt`）兜底回收。
 */

export type AuthTokenPurpose = "verify_email" | "reset_password" | "change_email";

/** 注册验证邮件的有效期。 */
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** 找回密码邮件的有效期（短一些：它能直接改密码）。 */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
/** 改绑邮箱验证码的有效期（6 位数字，必须短）。 */
export const EMAIL_CHANGE_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface AuthTokenDoc {
  /** 令牌明文的 SHA-256（hex）。 */
  _id: string;
  userId: string;
  email: string;
  purpose: AuthTokenPurpose;
  createdAt: number;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function ttlFor(purpose: AuthTokenPurpose): number {
  return purpose === "reset_password" ? RESET_TOKEN_TTL_MS : VERIFICATION_TOKEN_TTL_MS;
}

/**
 * 签发令牌（返回明文，只在此刻可见）。同一用户同一用途的旧令牌先失效，
 * 因此「连点两次发送」只有最后一封邮件有效。
 */
export async function issueAuthToken(
  userId: string,
  email: string,
  purpose: AuthTokenPurpose,
): Promise<{ token: string; expiresAt: number }> {
  const db = await getDb();
  const tokens = db.collection<AuthTokenDoc>("auth_tokens");
  await tokens.deleteMany({ userId, purpose });

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + ttlFor(purpose);
  await tokens.insertOne({
    _id: hashToken(token),
    userId,
    email,
    purpose,
    createdAt: now,
    expiresAt: new Date(expiresAt),
  });
  return { token, expiresAt };
}

/**
 * 消费令牌：命中并撤销同用户同用途的其余令牌，返回令牌记录；不存在 /
 * 已过期 / 用途不符一律返回 `null`。过期文档当场删除（TTL 线程只是兜底）。
 */
export async function consumeAuthToken(
  token: string,
  purpose: AuthTokenPurpose,
): Promise<AuthTokenDoc | null> {
  const trimmed = token.trim();
  if (trimmed.length < 16 || trimmed.length > 200) {
    return null;
  }
  const db = await getDb();
  const tokens = db.collection<AuthTokenDoc>("auth_tokens");
  const doc = await tokens.findOneAndDelete({ _id: hashToken(trimmed), purpose });
  if (!doc) {
    return null;
  }
  if (doc.expiresAt.getTime() <= Date.now()) {
    return null;
  }
  // 旧邮件里的其它令牌同样作废：一次重置 / 验证只用一封邮件。
  await tokens.deleteMany({ userId: doc.userId, purpose });
  return doc;
}

/** 撤销某用户某用途的全部令牌（改密后调用，旧重置链接立即失效）。 */
export async function revokeAuthTokens(userId: string, purpose?: AuthTokenPurpose): Promise<number> {
  const db = await getDb();
  const filter = purpose ? { userId, purpose } : { userId };
  const result = await db.collection<AuthTokenDoc>("auth_tokens").deleteMany(filter);
  return result.deletedCount;
}

/**
 * 签发改绑邮箱的 6 位验证码。
 *
 * 与链接令牌共用 `auth_tokens`，但明文只有 10^6 种可能，所以消费端额外
 * 绑定 `userId` + 目标 `email`（见 [consumeEmailChangeCode]）：知道别人的
 * 验证码也无法用在自己的会话上。同一用户只保留最新一条，重发即作废旧码。
 */
export async function issueEmailChangeCode(
  userId: string,
  email: string,
): Promise<{ code: string; expiresAt: number }> {
  const db = await getDb();
  const tokens = db.collection<AuthTokenDoc>("auth_tokens");
  await tokens.deleteMany({ userId, purpose: "change_email" });

  const now = Date.now();
  const expiresAt = now + EMAIL_CHANGE_TOKEN_TTL_MS;
  // 6 位码空间只有 10^6，哈希撞车会让 insertOne 抛 11000：换一个重试即可。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await tokens.insertOne({
        _id: hashToken(code),
        userId,
        email,
        purpose: "change_email",
        createdAt: now,
        expiresAt: new Date(expiresAt),
      });
      return { code, expiresAt };
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
    }
  }
  throw new Error("Unable to allocate an email change code.");
}

/**
 * 消费改绑验证码：必须同时命中用户、目标邮箱与用途，命中即删除。
 * 返回 `false` = 码错误 / 已过期 / 不属于这个用户或这个邮箱。
 */
export async function consumeEmailChangeCode(
  userId: string,
  email: string,
  code: string,
): Promise<boolean> {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) {
    return false;
  }
  const db = await getDb();
  const tokens = db.collection<AuthTokenDoc>("auth_tokens");
  const doc = await tokens.findOneAndDelete({
    _id: hashToken(trimmed),
    userId,
    email,
    purpose: "change_email",
  });
  if (!doc || doc.expiresAt.getTime() <= Date.now()) {
    return false;
  }
  // 一码一用：同一用户残留的其它改绑码一并作废。
  await tokens.deleteMany({ userId, purpose: "change_email" });
  return true;
}
