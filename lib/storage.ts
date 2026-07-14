import { put } from "@vercel/blob";
import { Redis } from "@upstash/redis";
import type { BackupManifest, MessengerBackupPayload, StoredUser, UserIndexEntry } from "@/lib/types";
import { env } from "@/lib/env";

const KEY_USERS_INDEX = "messenger:users:index";

const redis = new Redis({
  url: env.upstashRedisUrl(),
  token: env.upstashRedisToken(),
});

function userKey(userId: string) {
  return `messenger:user:${userId}`;
}

function userByEmailKey(email: string) {
  return `messenger:user:by-email:${email}`;
}

function backupManifestKey(userId: string) {
  return `messenger:backup:${userId}:manifest`;
}

export async function getUserByEmail(email: string) {
  const userId = await redis.get<string>(userByEmailKey(email));
  if (!userId) {
    return null;
  }
  return redis.get<StoredUser>(userKey(userId));
}

export async function getUserById(userId: string) {
  return redis.get<StoredUser>(userKey(userId));
}

export async function saveUser(user: StoredUser) {
  await redis.set(userKey(user.id), user);
  await redis.set(userByEmailKey(user.email), user.id);
  await upsertUserIndex({
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  });
}

export async function updateUserLastLogin(userId: string, lastLoginAt: number) {
  const user = await getUserById(userId);
  if (!user) {
    return;
  }
  const updatedUser: StoredUser = {
    ...user,
    lastLoginAt,
    updatedAt: lastLoginAt,
  };
  await redis.set(userKey(userId), updatedUser);
  await upsertUserIndex({
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: updatedUser.updatedAt,
  });
}

export async function getUsersIndex() {
  return (await redis.get<UserIndexEntry[]>(KEY_USERS_INDEX)) ?? [];
}

export async function upsertUserIndex(entry: UserIndexEntry) {
  const existing = await getUsersIndex();
  const next = existing.filter((item) => item.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  await redis.set(KEY_USERS_INDEX, next);
}

export async function getBackupManifest(userId: string) {
  return redis.get<BackupManifest>(backupManifestKey(userId));
}

export async function saveLatestBackup(
  userId: string,
  payload: MessengerBackupPayload,
  payloadJson: string,
  checksumSha256: string,
) {
  const current = await getBackupManifest(userId);
  const version = (current?.version ?? 0) + 1;
  const blobPath = `backups/${userId}/${version}.json`;
  const uploadedAt = Date.now();
  const blob = await put(blobPath, payloadJson, {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });

  const manifest: BackupManifest = {
    userId,
    version,
    schemaVersion: payload.schemaVersion,
    uploadedAt,
    blobPath,
    blobUrl: blob.url,
    sizeBytes: Buffer.byteLength(payloadJson, "utf8"),
    checksumSha256,
    recordCounts: {
      providers: payload.providers.length,
      models: payload.models.length,
      agents: payload.agents.length,
      conversations: payload.conversations.length,
      messages: payload.messages.length,
    },
    device: payload.device,
  };

  await redis.set(backupManifestKey(userId), manifest);

  const user = await getUserById(userId);
  if (user) {
    await upsertUserIndex({
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: uploadedAt,
      lastBackupAt: uploadedAt,
    });
  }

  return manifest;
}
