"use client";

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

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/format";

export interface EmailCardProps {
  email: string;
  emailVerifiedAt: number | null;
  /** 服务端是否配置了 SMTP；未配置时改绑入口禁用并给出原因。 */
  mailEnabled: boolean;
}

/**
 * 邮箱展示与改绑。两步：先「当前密码 + 新地址」换一封带 6 位验证码的邮件，
 * 再输入验证码确认。两步之间地址不可改（服务端把码绑定到目标地址），
 * 所以第二步只回显，不允许编辑。
 */
export function EmailCard({ email, emailVerifiedAt, mailEnabled }: EmailCardProps) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "sent">("idle");
  const [newEmail, setNewEmail] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [pendingEmail, setPendingEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep("idle");
    setNewEmail("");
    setCurrentPassword("");
    setPendingEmail("");
    setCode("");
    setError(null);
  }

  async function requestCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/change-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: newEmail.trim(), currentPassword }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; email?: string }
        | null;
      if (!response.ok) {
        setError(payload?.error ?? "发送失败，请稍后重试。");
        return;
      }
      setPendingEmail(payload?.email ?? newEmail.trim());
      setCurrentPassword("");
      setStep("sent");
      toast.success("验证码已发送，请查收新邮箱");
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/change-email/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pendingEmail, code: code.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(payload?.error ?? "验证码校验失败，请稍后重试。");
        return;
      }
      toast.success("登录邮箱已更换");
      reset();
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">登录邮箱</CardTitle>
        <CardDescription>
          更换后需用新邮箱登录。Messenger App 的云端账号同步使用同一邮箱，其它设备上的会话不会失效。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-medium">{email}</span>
          {emailVerifiedAt ? (
            <Badge variant="outline">已验证 · {formatDateTime(emailVerifiedAt)}</Badge>
          ) : (
            <Badge variant="secondary">未验证</Badge>
          )}
        </div>

        {!mailEnabled ? (
          <p className="text-sm text-muted-foreground">
            当前服务器未配置 SMTP，无法发送验证码，改绑邮箱暂不可用。
          </p>
        ) : step === "idle" ? (
          <form className="grid max-w-md gap-3" onSubmit={requestCode}>
            <div className="grid gap-2">
              <Label htmlFor="email-change-new">新邮箱</Label>
              <Input
                id="email-change-new"
                type="email"
                autoComplete="email"
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                placeholder="new@example.com"
                disabled={busy}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email-change-password">当前密码</Label>
              <Input
                id="email-change-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                disabled={busy}
                required
              />
            </div>
            <p className="text-xs text-muted-foreground">
              需要验证当前密码：更换登录邮箱等同于转移账号身份。我们会向新邮箱发送一封 6 位验证码邮件，10 分钟内有效。
            </p>
            <div>
              <Button type="submit" disabled={busy || !newEmail.trim() || !currentPassword}>
                {busy ? "发送中…" : "发送验证码"}
              </Button>
            </div>
          </form>
        ) : (
          <form className="grid max-w-md gap-3" onSubmit={confirm}>
            <p className="text-sm">
              验证码已发送至 <span className="break-all font-medium">{pendingEmail}</span>。
            </p>
            <div className="grid gap-2">
              <Label htmlFor="email-change-code">6 位验证码</Label>
              <Input
                id="email-change-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                className="max-w-40 font-mono tracking-[0.3em]"
                disabled={busy}
                required
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || code.length !== 6}>
                {busy ? "确认中…" : "确认更换"}
              </Button>
              <Button type="button" variant="ghost" onClick={reset} disabled={busy}>
                取消
              </Button>
            </div>
          </form>
        )}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
