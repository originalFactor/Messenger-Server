import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// scrypt 的同步版本会阻塞 Node.js 事件循环（单次约 50ms），
// 在 serverless 上会显著放大凭据填充攻击的影响。改用异步版本，
// 让其它请求可以在 scrypt 工作期间继续执行。
const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, stored] = hash.split(":");
  if (!salt || !stored) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const storedBuffer = Buffer.from(stored, "hex");
  return derived.length === storedBuffer.length && timingSafeEqual(derived, storedBuffer);
}
