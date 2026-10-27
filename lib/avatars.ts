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

import {
  BlobPreconditionFailedError,
  blobPathFromUrl,
  getBlobStore,
} from "@/lib/blob-store";
import { createLogger } from "@/lib/runtime-logs";

const blobStore = getBlobStore();

/** 头像域日志器：Blob 与数据库不一致（文件缺失）时留痕。 */
const avatarLog = createLogger("avatar");

type LockVerifier = () => Promise<void>;

export interface AvatarBlobBackup {
  url: string;
  pathname: string;
  etag: string;
  content: Buffer;
  contentType: string;
}

export interface AvatarReplacement {
  url: string;
  etag: string;
}

export class AvatarReplacementError extends Error {
  constructor(
    message: string,
    readonly restored: boolean,
  ) {
    super(message);
  }
}

export function userAvatarPath(userId: string, ext: string): string {
  return `avatars/users/${userId}.${ext}`;
}

export function agentAvatarPath(agentId: string, ext: string): string {
  return `avatars/agents/${agentId}.${ext}`;
}

export function marketAgentAvatarPath(agentId: string, ext: string): string {
  return `avatars/market_agents/${agentId}.${ext}`;
}

async function verifyLock(verify?: LockVerifier): Promise<void> {
  if (verify) {
    await verify();
  }
}

async function listByPrefix(prefix: string, verify?: LockVerifier) {
  await verifyLock(verify);
  // 存储层在内部翻页拉满后一次性返回；头像前缀下文件数很小。
  const page = await blobStore.list({ prefix });
  return page.blobs;
}

async function snapshotByPrefix(prefix: string, verify?: LockVerifier): Promise<AvatarBlobBackup[]> {
  const blobs = await listByPrefix(prefix, verify);
  // 串行下载并立即 buffer：每个头像最大 5 MiB，并发 Promise.all 会让多个
  // 头像同时驻留实例内存（几个并发请求就能 OOM）。
  // 串行处理时同一时刻只有一份 buffer 在内存里，并且 verifyLock 在每份
  // 之间刷新锁，避免锁过期。
  const backups: AvatarBlobBackup[] = [];
  for (const blob of blobs) {
    await verifyLock(verify);
    const stored = await blobStore.get(blob.pathname);
    if (!stored || stored.statusCode !== 200 || !stored.stream) {
      throw new Error(`Unable to preserve existing avatar blob: ${blob.pathname}`);
    }
    backups.push({
      url: blob.url,
      pathname: blob.pathname,
      etag: blob.etag,
      content: Buffer.from(await new Response(stored.stream).arrayBuffer()),
      contentType: stored.blob.contentType ?? "application/octet-stream",
    });
  }
  return backups;
}

async function deleteBackups(backups: AvatarBlobBackup[], verify?: LockVerifier): Promise<AvatarBlobBackup[]> {
  const deleted: AvatarBlobBackup[] = [];
  for (const backup of backups) {
    await verifyLock(verify);
    await blobStore.del(backup.url, { ifMatch: backup.etag });
    deleted.push(backup);
  }
  return deleted;
}

async function restoreBackups(backups: AvatarBlobBackup[], verify?: LockVerifier): Promise<boolean> {
  try {
    for (const backup of backups) {
      await verifyLock(verify);
      await blobStore.put(backup.pathname, backup.content, { contentType: backup.contentType });
    }
    return true;
  } catch {
    return false;
  }
}

async function replaceAvatar(
  backups: AvatarBlobBackup[],
  pathname: string,
  buffer: Buffer,
  contentType: string,
  verify?: LockVerifier,
): Promise<AvatarReplacement> {
  let deleted: AvatarBlobBackup[] = [];
  try {
    deleted = await deleteBackups(backups, verify);
    await verifyLock(verify);
    const blob = await blobStore.put(pathname, buffer, { contentType });
    return { url: blob.url, etag: blob.etag };
  } catch (error) {
    const restored = await restoreBackups(deleted, verify);
    const message = error instanceof Error ? error.message : "Unable to replace the avatar blob.";
    throw new AvatarReplacementError(message, restored);
  }
}

async function revertReplacement(
  replacement: AvatarReplacement,
  backups: AvatarBlobBackup[],
  verify?: LockVerifier,
): Promise<boolean> {
  try {
    await verifyLock(verify);
    await blobStore.del(replacement.url, { ifMatch: replacement.etag });
    return restoreBackups(backups, verify);
  } catch (error) {
    if (error instanceof BlobPreconditionFailedError) {
      return false;
    }
    return false;
  }
}

async function deleteByPrefix(prefix: string, verify?: LockVerifier): Promise<void> {
  const backups = await snapshotByPrefix(prefix, verify);
  await deleteBackups(backups, verify);
}

export async function snapshotUserAvatar(userId: string, verify?: LockVerifier): Promise<AvatarBlobBackup[]> {
  return snapshotByPrefix(`avatars/users/${userId}.`, verify);
}

export async function uploadUserAvatar(
  userId: string,
  backups: AvatarBlobBackup[],
  buffer: Buffer,
  ext: string,
  contentType: string,
  verify?: LockVerifier,
): Promise<AvatarReplacement> {
  return replaceAvatar(backups, userAvatarPath(userId, ext), buffer, contentType, verify);
}

export async function revertUserAvatar(
  replacement: AvatarReplacement,
  backups: AvatarBlobBackup[],
  verify?: LockVerifier,
): Promise<boolean> {
  return revertReplacement(replacement, backups, verify);
}

export async function deleteUserAvatar(userId: string, verify?: LockVerifier): Promise<void> {
  await deleteByPrefix(`avatars/users/${userId}.`, verify);
}

export async function snapshotAgentAvatar(agentId: string, verify?: LockVerifier): Promise<AvatarBlobBackup[]> {
  return snapshotByPrefix(`avatars/agents/${agentId}.`, verify);
}

export async function uploadAgentAvatar(
  agentId: string,
  backups: AvatarBlobBackup[],
  buffer: Buffer,
  ext: string,
  contentType: string,
  verify?: LockVerifier,
): Promise<AvatarReplacement> {
  return replaceAvatar(backups, agentAvatarPath(agentId, ext), buffer, contentType, verify);
}

export async function revertAgentAvatar(
  replacement: AvatarReplacement,
  backups: AvatarBlobBackup[],
  verify?: LockVerifier,
): Promise<boolean> {
  return revertReplacement(replacement, backups, verify);
}

export async function deleteAgentAvatar(agentId: string, verify?: LockVerifier): Promise<void> {
  await deleteByPrefix(`avatars/agents/${agentId}.`, verify);
}

export async function snapshotMarketAgentAvatar(
  agentId: string,
  verify?: LockVerifier,
): Promise<AvatarBlobBackup[]> {
  return snapshotByPrefix(`avatars/market_agents/${agentId}.`, verify);
}

export async function uploadMarketAgentAvatar(
  agentId: string,
  backups: AvatarBlobBackup[],
  buffer: Buffer,
  ext: string,
  contentType: string,
  verify?: LockVerifier,
): Promise<AvatarReplacement> {
  return replaceAvatar(backups, marketAgentAvatarPath(agentId, ext), buffer, contentType, verify);
}

export async function revertMarketAgentAvatar(
  replacement: AvatarReplacement,
  backups: AvatarBlobBackup[],
  verify?: LockVerifier,
): Promise<boolean> {
  return revertReplacement(replacement, backups, verify);
}

export async function deleteMarketAgentAvatar(agentId: string, verify?: LockVerifier): Promise<void> {
  await deleteByPrefix(`avatars/market_agents/${agentId}.`, verify);
}

/**
 * 将数据库里的头像引用规范化为逻辑路径并校验前缀。
 */
function avatarLogicalPathFromUrl(url: string): string {
  const logicalPath = blobPathFromUrl(url);
  if (!logicalPath.startsWith("avatars/")) {
    throw new Error(`Invalid avatar pathname: ${logicalPath}`);
  }
  return logicalPath;
}

/**
 * 200 一定带内容流、304 一定没有——用判别联合表达，路由端就不需要再写
 * 一个「200 但没有流」的死分支。
 */
export type AvatarFetchResult =
  | { statusCode: 304; etag: string }
  | { statusCode: 200; etag: string; contentType: string | null; stream: ReadableStream<Uint8Array> };

/**
 * 已经报告过「文件缺失」的路径。头像 GET 在每个页面渲染时都会触发，同一条
 * 漂移若逐次写 `runtime_logs` 会变成日志噪声，所以每条路径只记一次。
 */
const reportedMissingBlobs = new Set<string>();

function reportMissingBlob(pathname: string, message: string): void {
  if (reportedMissingBlobs.has(pathname)) {
    return;
  }
  // 有界：头像路径数量与用户/Agent 数量同阶，但这里仍设上限防止长进程无界增长。
  if (reportedMissingBlobs.size >= 1_000) {
    reportedMissingBlobs.clear();
  }
  reportedMissingBlobs.add(pathname);
  avatarLog.warn(message, { pathname });
}

/**
 * Avatar GET 的共享逻辑：条件 GET（ifNoneMatch 命中时后端只回 304 +
 * 元数据、不回内容流）；未命中才把完整内容流回传。
 *
 * 返回 `null` = 数据库里记着头像、但对象已不在存储桶中。这是客户端可恢复
 * 的状态，不是服务端故障：路由据此回 `404 Avatar not found.`，让客户端
 * 回落到默认头像。此前
 * 这里直接 throw，于是每一次页面渲染都变成 500 + 整段堆栈。
 */
export async function fetchAvatarWithConditional(
  avatarUrl: string,
  ifNoneMatch: string | null,
): Promise<AvatarFetchResult | null> {
  const logicalPath = avatarLogicalPathFromUrl(avatarUrl);
  const avatar = await blobStore.get(logicalPath, ifNoneMatch ? { ifNoneMatch } : undefined);
  if (!avatar) {
    reportMissingBlob(logicalPath, "Avatar blob is missing for a recorded avatarUrl.");
    return null;
  }
  if (avatar.statusCode === 304) {
    return { statusCode: 304, etag: avatar.blob.etag };
  }
  if (!avatar.stream) {
    reportMissingBlob(logicalPath, "Avatar blob returned no content stream.");
    return null;
  }
  return {
    statusCode: 200,
    etag: avatar.blob.etag,
    contentType: avatar.blob.contentType,
    stream: avatar.stream,
  };
}
