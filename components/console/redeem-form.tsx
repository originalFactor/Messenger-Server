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

interface RedeemSuccess {
  planName: string;
  quotaTokens: number;
  validityDays: number;
}

export function RedeemForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<RedeemSuccess | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/console/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redemption?: { planName: string; quotaTokens: number; validityDays: number };
      } | null;
      if (!response.ok || !payload?.redemption) {
        setError(payload?.error ?? "兑换失败，请稍后重试。");
        return;
      }
      setSuccess({
        planName: payload.redemption.planName,
        quotaTokens: payload.redemption.quotaTokens,
        validityDays: payload.redemption.validityDays,
      });
      setCode("");
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="kicker">兑换卡密</div>
      <p className="muted" style={{ margin: "8px 0 16px" }}>
        兑换成功后额度立即到账，有效期从当前有效期之后顺延。
      </p>
      <form className="toolbar" onSubmit={handleSubmit}>
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label htmlFor="card-code">卡密</label>
          <input
            id="card-code"
            className="input mono"
            required
            placeholder="MS-XXXXX-XXXXX-XXXXX"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <button className="button" type="submit" disabled={busy}>
          {busy ? "兑换中…" : "兑换"}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {success ? (
        <div className="notice">
          兑换成功：{success.planName}，+{success.quotaTokens} 额度，有效期 {success.validityDays} 天。
        </div>
      ) : null}
    </div>
  );
}
