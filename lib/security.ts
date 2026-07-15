import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, hash: string): boolean {
  const [salt, stored] = hash.split(":");
  if (!salt || !stored) {
    return false;
  }
  const derived = scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(stored, "hex");
  return derived.length === storedBuffer.length && timingSafeEqual(derived, storedBuffer);
}
