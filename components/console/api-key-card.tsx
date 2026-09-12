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

export function ApiKeyCard({ apiKey }: { apiKey: string }) {
  const router = useRouter();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasKey = Boolean(apiKey);
  const masked = hasKey ? `${apiKey.slice(0, 8)}${"•".repeat(24)}${apiKey.slice(-4)}` : "";

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
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
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  if (!hasKey) {
    return (
      <div className="panel">
        <div className="kicker">AI API 密钥</div>
        <p className="muted" style={{ margin: "8px 0 16px" }}>
          当前账号还没有 AI API 密钥，生成后即可在 Messenger 中使用云 AI 服务。
        </p>
        {error ? <p className="error">{error}</p> : null}
        <button className="button" type="button" onClick={regenerate} disabled={busy}>
          {busy ? "生成中…" : "生成密钥"}
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="topbar" style={{ marginBottom: 8 }}>
        <div>
          <div className="kicker">AI API 密钥</div>
          <p className="muted" style={{ margin: "8px 0 0" }}>
            Messenger 应用登录后会自动以此密钥配置内置的 Messenger Cloud AI 服务商；
            也可用于任意 OpenAI 兼容客户端，Base URL 填 <span className="mono">{"/v1"}</span>。
          </p>
        </div>
      </div>
      <div className="row">
        <span className="chip">{revealed ? apiKey : masked}</span>
        <button className="button-secondary button-small" type="button" onClick={() => setRevealed((value) => !value)}>
          {revealed ? "隐藏" : "显示"}
        </button>
        <button className="button-secondary button-small" type="button" onClick={copyKey}>
          {copied ? "已复制" : "复制"}
        </button>
        <button className="button-danger button-small" type="button" onClick={regenerate} disabled={busy}>
          {busy ? "重置中…" : "重置密钥"}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
