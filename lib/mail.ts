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

import nodemailer, { type Transporter } from "nodemailer";
import { appUrl, smtpSettings } from "@/lib/env";
import { createLogger } from "@/lib/runtime-logs";

/**
 * 出信（SMTP）。
 *
 * 未配置 `SMTP_HOST` 时整站不发信：注册照常成功（只是不动邮箱验证状态），
 * 找回密码接口直接返回 503 而不是静默吞掉——让「邮件永远收不到」可见。
 *
 * transporter 缓存在 globalThis 上：Next.js 的开发热重载会重新求值模块，
 * 每次新建 transporter 会泄漏 TCP 连接。不启用连接池：本服务发信频率极低
 * （注册验证 / 重置密码），单发一连接比维护池里的空闲长连接更省事。
 */

const mailLog = createLogger("auth");

const globalForMail = globalThis as unknown as {
  messengerMailTransport?: Transporter;
};

/** 是否配置了 SMTP（未配置则所有出信功能关闭）。 */
export function mailEnabled(): boolean {
  return smtpSettings() !== null;
}

function getTransport(): Transporter {
  const settings = smtpSettings();
  if (!settings) {
    throw new Error("SMTP is not configured.");
  }
  if (!globalForMail.messengerMailTransport) {
    globalForMail.messengerMailTransport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.user
        ? { user: settings.user, pass: settings.password ?? "" }
        : undefined,
      // 自建 SMTP 常带自签证书；不在这里放宽校验，交给运维配置可信 CA。
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return globalForMail.messengerMailTransport;
}

interface MailContent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * 发送一封事务邮件。失败只记日志并返回 `false`，不向调用方抛出——注册
 * 这类流程不能在用户已创建后因为邮件服务抖动而整体失败。
 */
async function sendMail(content: MailContent): Promise<boolean> {
  const settings = smtpSettings();
  if (!settings) {
    mailLog.warn("Mail skipped: SMTP is not configured.", { reason: "smtp-missing" });
    return false;
  }
  try {
    const info = await getTransport().sendMail({
      from: settings.from,
      to: content.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    mailLog.info("Mail sent.", { subject: content.subject, messageId: info.messageId });
    return true;
  } catch (error) {
    mailLog.error("Mail delivery failed.", {
      subject: content.subject,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    return false;
  }
}

/** 邮件正文外壳：纯内联样式，邮件客户端不加载外部资源。 */
function layout(options: { heading: string; paragraphs: string[]; action: { label: string; href: string }; note: string }): string {
  const paragraphs = options.paragraphs
    .map((paragraph) => `<p style="margin:0 0 12px;line-height:1.6">${paragraph}</p>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;padding:24px;background:#f6f6f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#18181b">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 16px;font-size:18px">${options.heading}</h1>
      ${paragraphs}
      <p style="margin:24px 0">
        <a href="${options.action.href}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px">${options.action.label}</a>
      </p>
      <p style="margin:0 0 12px;font-size:12px;color:#71717a;word-break:break-all">按钮无效时复制此链接到浏览器打开：<br>${options.action.href}</p>
      <p style="margin:0;font-size:12px;color:#71717a">${options.note}</p>
    </div>
  </body>
</html>`;
}

/** 注册后的邮箱验证邮件。 */
export function verificationEmail(email: string, token: string, expiresInHours: number): MailContent {
  const link = `${appUrl("/verify-email")}?token=${encodeURIComponent(token)}`;
  return {
    to: email,
    subject: "验证你的 Messenger Cloud 邮箱",
    text: [
      "欢迎使用 Messenger Cloud。",
      "",
      "请打开下面的链接验证邮箱地址：",
      link,
      "",
      `链接 ${expiresInHours} 小时内有效。如果这不是你本人的操作，忽略本邮件即可。`,
    ].join("\n"),
    html: layout({
      heading: "验证你的邮箱",
      paragraphs: [
        "欢迎使用 Messenger Cloud。点击下面的按钮完成邮箱验证。",
        `链接 ${expiresInHours} 小时内有效。`,
      ],
      action: { label: "验证邮箱", href: link },
      note: "如果这不是你本人的操作，忽略本邮件即可，账号不会被改动。",
    }),
  };
}

/** 找回密码邮件。 */
export function passwordResetEmail(email: string, token: string, expiresInMinutes: number): MailContent {
  const link = `${appUrl("/reset-password")}?token=${encodeURIComponent(token)}`;
  return {
    to: email,
    subject: "重置你的 Messenger Cloud 密码",
    text: [
      "我们收到了重置该账号密码的请求。",
      "",
      "请打开下面的链接设置新密码：",
      link,
      "",
      `链接 ${expiresInMinutes} 分钟内有效，且只能使用一次。`,
      "如果这不是你本人的操作，忽略本邮件即可，当前密码仍然有效。",
    ].join("\n"),
    html: layout({
      heading: "重置密码",
      paragraphs: [
        "我们收到了重置该账号密码的请求。点击下面的按钮设置新密码。",
        `链接 ${expiresInMinutes} 分钟内有效，且只能使用一次。`,
      ],
      action: { label: "设置新密码", href: link },
      note: "如果这不是你本人的操作，忽略本邮件即可，当前密码仍然有效。",
    }),
  };
}

/** 发送邮箱验证邮件；未配置 SMTP 或投递失败时返回 `false`。 */
export async function sendVerificationEmail(email: string, token: string, expiresInHours: number): Promise<boolean> {
  return sendMail(verificationEmail(email, token, expiresInHours));
}

/** 发送找回密码邮件；未配置 SMTP 或投递失败时返回 `false`。 */
export async function sendPasswordResetEmail(email: string, token: string, expiresInMinutes: number): Promise<boolean> {
  return sendMail(passwordResetEmail(email, token, expiresInMinutes));
}
