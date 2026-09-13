"use client";

/*
 * Copyright 2026 ECSDevs
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
import { useRouter } from "next/navigation";
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

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (isRegister && password !== confirm) {
      setError("两次输入的密码不一致。");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "操作失败，请稍后重试。");
        return;
      }
      router.push("/console");
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <CardTitle className="text-xl">{isRegister ? "创建账号" : "登录 Messenger Cloud"}</CardTitle>
        <CardDescription>
          {isRegister ? "注册后即可使用云同步与内置 AI 服务" : "使用邮箱与密码继续"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="email">邮箱</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? "至少 8 位" : "密码"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {isRegister ? (
            <div className="grid gap-2">
              <Label htmlFor="confirm">确认密码</Label>
              <Input
                id="confirm"
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="再次输入密码"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button type="submit" disabled={busy}>
            {busy ? "请稍候…" : isRegister ? "注册" : "登录"}
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-muted-foreground">
          {isRegister ? (
            <>
              已有账号？
              <Link className="font-medium text-foreground underline-offset-4 hover:underline" href="/login">
                直接登录
              </Link>
            </>
          ) : (
            <>
              还没有账号？
              <Link className="font-medium text-foreground underline-offset-4 hover:underline" href="/register">
                立即注册
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
