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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * 「邮箱未验证」提醒：控制台顶部常驻，直到用户点开邮件里的链接。
 * 重发按钮走登录态接口，服务端会按 IP + 账号限流。
 */
export function EmailVerificationBanner({ email }: { email: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  async function resend() {
    setBusy(true);
    try {
      const response = await fetch("/api/auth/verify-email/resend", { method: "POST" });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; alreadyVerified?: boolean }
        | null;
      if (!response.ok) {
        toast.error(payload?.error ?? "发送失败，请稍后重试。");
        return;
      }
      if (payload?.alreadyVerified) {
        toast.success("邮箱已验证");
        router.refresh();
        return;
      }
      toast.success("验证邮件已发送，请查收");
    } catch {
      toast.error("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (dismissed) {
    return null;
  }

  return (
    <Alert className="mb-4">
      <AlertTitle>邮箱尚未验证</AlertTitle>
      <AlertDescription>
        <span className="mb-2 block">
          验证后才能在忘记密码时收到重置邮件。我们已向 {email} 发送验证链接。
        </span>
        <span className="flex flex-wrap gap-2">
          <Button size="sm" onClick={resend} disabled={busy}>
            {busy ? "发送中…" : "重新发送验证邮件"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            暂时忽略
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
