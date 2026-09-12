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

import {
  BlobPreconditionFailedError,
  blobPathFromUrl,
  getBlobStore,
} from "@/lib/blob-store";

const blobStore = getBlobStore();

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
  // 两个后端都在内部翻页拉满后一次性返回；头像前缀下文件数很小。
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

export async function snapshotMarketAgentAvatar(agentId: string): Promise<AvatarBlobBackup[]> {
  return snapshotByPrefix(`avatars/market_agents/${agentId}.`);
}

export async function uploadMarketAgentAvatar(
  agentId: string,
  backups: AvatarBlobBackup[],
  buffer: Buffer,
  ext: string,
  contentType: string,
): Promise<AvatarReplacement> {
  return replaceAvatar(backups, marketAgentAvatarPath(agentId, ext), buffer, contentType);
}

export async function revertMarketAgentAvatar(
  replacement: AvatarReplacement,
  backups: AvatarBlobBackup[],
): Promise<boolean> {
  return revertReplacement(replacement, backups);
}

export async function deleteMarketAgentAvatar(agentId: string): Promise<void> {
  await deleteByPrefix(`avatars/market_agents/${agentId}.`);
}

/**
 * DB 里的 avatarUrl 既可能是 fs 后端的裸 pathname，也可能是历史 Vercel
 * Blob 后端写入的完整 URL；统一规范化为逻辑路径并校验前缀。
 */
function avatarLogicalPathFromUrl(url: string): string {
  const logicalPath = blobPathFromUrl(url);
  if (!logicalPath.startsWith("avatars/")) {
    throw new Error(`Invalid avatar pathname: ${logicalPath}`);
  }
  return logicalPath;
}

export interface AvatarFetchResult {
  // HTTP 状态码：200 表示命中内容流，304 表示客户端缓存仍然有效。
  statusCode: 200 | 304;
  etag: string;
  contentType?: string | null;
  stream?: ReadableStream<Uint8Array> | null;
}

/**
 * Avatar GET 的共享逻辑：条件 GET（ifNoneMatch 命中时后端只回 304 +
 * 元数据、不回内容流）；未命中才把完整内容流回传。
 */
export async function fetchAvatarWithConditional(
  avatarUrl: string,
  ifNoneMatch: string | null,
): Promise<AvatarFetchResult> {
  const logicalPath = avatarLogicalPathFromUrl(avatarUrl);
  const avatar = await blobStore.get(logicalPath, ifNoneMatch ? { ifNoneMatch } : undefined);
  if (!avatar) {
    throw new Error("Avatar blob is unavailable.");
  }
  if (avatar.statusCode === 304) {
    return { statusCode: 304, etag: avatar.blob.etag };
  }
  if (!avatar.stream) {
    throw new Error("Avatar blob is unavailable.");
  }
  return {
    statusCode: 200,
    etag: avatar.blob.etag,
    contentType: avatar.blob.contentType,
    stream: avatar.stream,
  };
}
