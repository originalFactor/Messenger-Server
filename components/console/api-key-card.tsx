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
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function ApiKeyCard({ apiKey }: { apiKey: string }) {
  const router = useRouter();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasKey = Boolean(apiKey);
  const masked = hasKey ? `${apiKey.slice(0, 8)}${"•".repeat(24)}${apiKey.slice(-4)}` : "";

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(apiKey);
      toast.success("已复制到剪贴板");
    } catch {
      setError("复制失败，请手动选择复制。");
    }
  }

  async function regenerate() {
    if (
      hasKey &&
      !window.confirm("重置后旧 Key 将立即失效，Messenger 应用内置服务商也需要重新同步。确定重置？")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/console/api-key", { method: "POST" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "重置失败，请稍后重试。");
        return;
      }
      setRevealed(true);
      toast.success(hasKey ? "密钥已重置" : "密钥已生成");
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
        <CardTitle className="text-base">AI API 密钥</CardTitle>
        <CardDescription>
          Messenger 应用登录后会自动以此密钥配置内置的 Messenger Cloud AI 服务商；也可用于任意
          OpenAI 兼容客户端，Base URL 填 <code className="font-mono text-xs">/v1</code>。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {hasKey ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly value={revealed ? apiKey : masked} className="max-w-md font-mono text-xs" />
            <Button variant="outline" size="sm" onClick={() => setRevealed((value) => !value)}>
              {revealed ? "隐藏" : "显示"}
            </Button>
            <Button variant="outline" size="sm" onClick={copyKey}>
              复制
            </Button>
            <Button variant="destructive" size="sm" onClick={regenerate} disabled={busy}>
              {busy ? "重置中…" : "重置密钥"}
            </Button>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-muted-foreground">
              当前账号还没有 AI API 密钥，生成后即可在 Messenger 中使用云 AI 服务。
            </p>
            <Button onClick={regenerate} disabled={busy}>
              {busy ? "生成中…" : "生成密钥"}
            </Button>
          </div>
        )}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
