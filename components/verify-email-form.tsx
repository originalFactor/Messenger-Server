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

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type State =
  | { kind: "missing" }
  | { kind: "pending" }
  | { kind: "verified" }
  | { kind: "failed"; message: string };

/**
 * 邮箱验证落地页：挂载即提交令牌（链接是 GET，令牌不能停在地址栏里被
 * 分享/预取），随后只展示结果。`useRef` 挡住 StrictMode 的二次执行——
 * 令牌是一次性的，重复提交只会拿到「已失效」。
 */
export function VerifyEmailForm({ token }: { token: string }) {
  const [state, setState] = useState<State>(() => (token === "" ? { kind: "missing" } : { kind: "pending" }));
  const submitted = useRef(false);

  useEffect(() => {
    if (token === "" || submitted.current) {
      return;
    }
    submitted.current = true;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/verify-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) {
          return;
        }
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          setState({ kind: "failed", message: payload?.error ?? "验证失败，请稍后重试。" });
          return;
        }
        setState({ kind: "verified" });
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "网络错误，请稍后重试。" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="items-center text-center">
        <CardTitle className="text-xl">邮箱验证</CardTitle>
        <CardDescription>
          {state.kind === "verified"
            ? "验证成功"
            : state.kind === "pending"
              ? "正在验证…"
              : state.kind === "missing"
                ? "链接不完整"
                : "验证未完成"}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm text-muted-foreground">
        {state.kind === "verified" ? (
          <>
            <p>你的邮箱已验证，现在可以正常接收找回密码等账户邮件。</p>
            <Button asChild>
              <Link href="/console">进入控制台</Link>
            </Button>
          </>
        ) : null}
        {state.kind === "pending" ? <p>请稍候，不要关闭页面。</p> : null}
        {state.kind === "missing" ? (
          <>
            <p>这个链接没有带上验证令牌，可能没有被完整复制。</p>
            <Button asChild variant="outline">
              <Link href="/console">进入控制台重新发送</Link>
            </Button>
          </>
        ) : null}
        {state.kind === "failed" ? (
          <>
            <p>{state.message}</p>
            <p>登录后在控制台可以重新发送验证邮件。</p>
            <Button asChild>
              <Link href="/login">去登录</Link>
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
