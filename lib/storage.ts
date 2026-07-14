import { kv } from "@vercel/kv";
import { put } from "@vercel/blob";
import type { BackupManifest, MessengerBackupPayload, StoredUser, UserIndexEntry } from "@/lib/types";

const KEY_USERS_INDEX = "messenger:users:index";

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
  const userId = await kv.get<string>(userByEmailKey(email));
  if (!userId) {
    return null;
  }
  return kv.get<StoredUser>(userKey(userId));
}

export async function getUserById(userId: string) {
  return kv.get<StoredUser>(userKey(userId));
}

export async function saveUser(user: StoredUser) {
  await kv.set(userKey(user.id), user);
  await kv.set(userByEmailKey(user.email), user.id);
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
  await kv.set(userKey(userId), updatedUser);
  await upsertUserIndex({
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: updatedUser.updatedAt,
  });
}

export async function getUsersIndex() {
  return (await kv.get<UserIndexEntry[]>(KEY_USERS_INDEX)) ?? [];
}

export async function upsertUserIndex(entry: UserIndexEntry) {
  const existing = await getUsersIndex();
  const next = existing.filter((item) => item.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  await kv.set(KEY_USERS_INDEX, next);
}

export async function getBackupManifest(userId: string) {
  return kv.get<BackupManifest>(backupManifestKey(userId));
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
      agents: payload.agents.length,
      conversations: payload.conversations.length,
      messages: payload.messages.length,
    },
    device: payload.device,
  };

  await kv.set(backupManifestKey(userId), manifest);

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
