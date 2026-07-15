import { randomUUID } from "node:crypto";
import { type ClientSession, MongoServerError } from "mongodb";
import { getDb } from "@/lib/mongo";

interface AvatarLockDoc {
  _id: string;
  token: string;
  expiresAt: Date;
}

export interface AvatarLock {
  id: string;
  token: string;
}

export class AvatarLockError extends Error {}

const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_WAIT_TIMEOUT_MS = 10 * 1000;
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_RENEW_INTERVAL_MS = 60 * 1000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireAvatarLock(lockId: string): Promise<AvatarLock> {
  const db = await getDb();
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    const now = new Date();
    try {
      const lock = await db.collection<AvatarLockDoc>("avatar_locks").findOneAndUpdate(
        {
          _id: lockId,
          $or: [
            { expiresAt: { $lte: now } },
            { expiresAt: { $exists: false } },
          ],
        },
        {
          $set: {
            token,
            expiresAt: new Date(now.getTime() + LOCK_TIMEOUT_MS),
          },
        },
        { upsert: true, returnDocument: "after", includeResultMetadata: false },
      );
      if (lock?.token === token) {
        return { id: lockId, token };
      }
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.code !== 11000) {
        throw error;
      }
    }

    if (Date.now() >= deadline) {
      throw new AvatarLockError("Another avatar change is still in progress.");
    }
    await delay(LOCK_RETRY_DELAY_MS);
  }
}

export async function renewAvatarLock(lock: AvatarLock, session?: ClientSession): Promise<void> {
  const db = await getDb();
  const now = new Date();
  const renewed = await db.collection<AvatarLockDoc>("avatar_locks").findOneAndUpdate(
    { _id: lock.id, token: lock.token, expiresAt: { $gt: now } },
    { $set: { expiresAt: new Date(now.getTime() + LOCK_TIMEOUT_MS) } },
    { returnDocument: "after", includeResultMetadata: false, session },
  );
  if (!renewed) {
    throw new AvatarLockError("The avatar change was superseded by another request.");
  }
}

async function releaseAvatarLock(lock: AvatarLock): Promise<void> {
  const db = await getDb();
  await db.collection<AvatarLockDoc>("avatar_locks").deleteOne({ _id: lock.id, token: lock.token });
}

export async function withAvatarLock<T>(
  lockId: string,
  operation: (lock: AvatarLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireAvatarLock(lockId);
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    void renewAvatarLock(lock).catch((error: unknown) => {
      heartbeatError ??= error;
    });
  }, LOCK_RENEW_INTERVAL_MS);
  try {
    const result = await operation(lock);
    if (heartbeatError) {
      throw heartbeatError;
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    await releaseAvatarLock(lock).catch(() => undefined);
  }
}
