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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  jwtSecret: () => requireEnv("JWT_SECRET"),
  appBaseUrl: () => process.env.APP_BASE_URL ?? "http://localhost:3000",
  mongoUri: () => requireEnv("MONGODB_URI"),
  mongoDbName: () => process.env.MONGODB_DB_NAME ?? "messenger",
  s3Bucket: () => requireEnv("S3_BUCKET"),
  s3Region: () => process.env.S3_REGION || "us-east-1",
  s3Endpoint: () => process.env.S3_ENDPOINT || undefined,
  s3ForcePathStyle: () => process.env.S3_FORCE_PATH_STYLE === "true",
  s3Credentials: () => {
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new Error("S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together");
    }
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
  },
};

export function appUrl(path: string): string {
  return new URL(path, `${env.appBaseUrl().replace(/\/+$/, "")}/`).toString();
}

/** SMTP 出信配置（`SMTP_HOST` 缺失即整站不发信）。 */
export interface SmtpSettings {
  host: string;
  port: number;
  /** 465 隐式 TLS；587 走 STARTTLS（nodemailer 按服务端能力升级）。 */
  secure: boolean;
  user: string | null;
  password: string | null;
  /** 信封 From，默认 `Messenger Cloud <no-reply@APP_BASE_URL 主机名>`。 */
  from: string;
}

function appHostname(): string {
  try {
    return new URL(env.appBaseUrl()).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

/**
 * 解析 SMTP 配置：未设置 `SMTP_HOST` 返回 `null`（发信功能整体关闭，
 * 注册与登录不受影响）。端口缺失按 587，`SMTP_SECURE` 未显式设置时
 * 465 = 隐式 TLS、其余 = STARTTLS。
 */
export function smtpSettings(): SmtpSettings | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    return null;
  }
  const portValue = Number(process.env.SMTP_PORT?.trim() || "587");
  const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65_535 ? portValue : 587;
  const secureFlag = process.env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureFlag === "1" || secureFlag === "true"
    ? true
    : secureFlag === "0" || secureFlag === "false"
      ? false
      : port === 465;
  const user = process.env.SMTP_USER?.trim() || null;
  const password = process.env.SMTP_PASSWORD?.trim() || null;
  const from = process.env.SMTP_FROM?.trim()
    || `Messenger Cloud <no-reply@${appHostname()}>`;
  return { host, port, secure, user, password, from };
}
