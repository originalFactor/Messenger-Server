import { BlobPreconditionFailedError, del, get, list, put } from "vercel-blob-nonvercel";

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
  const blobs = [] as Awaited<ReturnType<typeof list>>["blobs"];
  let cursor: string | undefined;
  do {
    await verifyLock(verify);
    const page = await list({ prefix, cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function snapshotByPrefix(prefix: string, verify?: LockVerifier): Promise<AvatarBlobBackup[]> {
  const blobs = await listByPrefix(prefix, verify);
  return Promise.all(blobs.map(async (blob) => {
    await verifyLock(verify);
    const stored = await get(blob.pathname, { access: "private", useCache: false });
    if (!stored || stored.statusCode !== 200 || !stored.stream) {
      throw new Error(`Unable to preserve existing avatar blob: ${blob.pathname}`);
    }
    return {
      url: blob.url,
      pathname: blob.pathname,
      etag: blob.etag,
      content: Buffer.from(await new Response(stored.stream).arrayBuffer()),
      contentType: stored.blob.contentType,
    };
  }));
}

async function deleteBackups(backups: AvatarBlobBackup[], verify?: LockVerifier): Promise<AvatarBlobBackup[]> {
  const deleted: AvatarBlobBackup[] = [];
  for (const backup of backups) {
    await verifyLock(verify);
    await del(backup.url, { ifMatch: backup.etag });
    deleted.push(backup);
  }
  return deleted;
}

async function restoreBackups(backups: AvatarBlobBackup[], verify?: LockVerifier): Promise<boolean> {
  try {
    for (const backup of backups) {
      await verifyLock(verify);
      await put(backup.pathname, backup.content, {
        access: "private",
        addRandomSuffix: false,
        contentType: backup.contentType,
        cacheControlMaxAge: 60,
      });
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
    const blob = await put(pathname, buffer, {
      access: "private",
      addRandomSuffix: false,
      contentType,
      cacheControlMaxAge: 60,
    });
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
    await del(replacement.url, { ifMatch: replacement.etag });
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

export async function getAvatar(url: string) {
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname.replace(/^\/+/, "");
  const storageBase = process.env.VERCEL_BLOB_STORAGE_URL;
  const storagePath = storageBase
    ? new URL(storageBase).pathname.replace(/^\/+|\/+$/g, "")
    : "";
  const logicalPath = storagePath &&
      (pathname === storagePath || pathname.startsWith(`${storagePath}/`))
    ? pathname.slice(storagePath.length).replace(/^\/+/, "")
    : pathname;

  if (!logicalPath.startsWith("avatars/")) {
    throw new Error(`Invalid avatar pathname: ${logicalPath}`);
  }
  return get(logicalPath, { access: "private", useCache: false });
}

function avatarLogicalPathFromUrl(url: string): string {
  const parsedUrl = new URL(url);
  const pathname = parsedUrl.pathname.replace(/^\/+/, "");
  const storageBase = process.env.VERCEL_BLOB_STORAGE_URL;
  const storagePath = storageBase
    ? new URL(storageBase).pathname.replace(/^\/+|\/+$/g, "")
    : "";
  const logicalPath = storagePath &&
      (pathname === storagePath || pathname.startsWith(`${storagePath}/`))
    ? pathname.slice(storagePath.length).replace(/^\/+/, "")
    : pathname;
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
 * Avatar GET 的共享逻辑：用 SDK 的 ifNoneMatch 直接做条件 GET，
 * 命中时 Vercel Blob 只回 304 + 元数据、不回内容流；
 * 未命中才把完整字节流回传到 serverless 实例。
 */
export async function fetchAvatarWithConditional(
  avatarUrl: string,
  ifNoneMatch: string | null,
): Promise<AvatarFetchResult> {
  const logicalPath = avatarLogicalPathFromUrl(avatarUrl);
  const avatar = await get(logicalPath, {
    access: "private",
    useCache: false,
    ...(ifNoneMatch ? { ifNoneMatch } : {}),
  });
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
