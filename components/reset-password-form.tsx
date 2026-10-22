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
import Link from "next/link";
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

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "重置失败，请稍后重试。");
        return;
      }
      setDone(true);
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <CardTitle className="text-xl">设置新密码</CardTitle>
        <CardDescription>
          {done ? "密码已重置" : "重置后所有设备都需要用新密码重新登录"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {token === "" ? (
          <div className="grid gap-4 text-sm text-muted-foreground">
            <p>这个链接缺少重置令牌，可能没有被完整复制。请重新申请一封重置邮件。</p>
            <Button asChild variant="outline">
              <Link href="/forgot-password">重新申请</Link>
            </Button>
          </div>
        ) : done ? (
          <div className="grid gap-4 text-sm text-muted-foreground">
            <p>新密码已生效，该账号在其它设备上的登录状态已全部注销。</p>
            <Button asChild>
              <Link href="/login">去登录</Link>
            </Button>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="password">新密码</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="至少 8 位"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm">确认新密码</Label>
              <Input
                id="confirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="再次输入新密码"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" disabled={busy}>
              {busy ? "提交中…" : "保存新密码"}
            </Button>
          </form>
        )}
        {token !== "" && !done ? (
          <p className="mt-5 text-center text-sm text-muted-foreground">
            链接失效了？
            <Link
              className="font-medium text-foreground underline-offset-4 hover:underline"
              href="/forgot-password"
            >
              重新申请
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
