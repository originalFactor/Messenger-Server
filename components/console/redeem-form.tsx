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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { formatTokens } from "@/lib/format";

interface CardPreview {
  code: string;
  planName: string;
  quotaTokens: number;
  validityDays: number;
}

export function RedeemForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CardPreview | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/console/cards/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        card?: CardPreview;
      } | null;
      if (!response.ok || !payload?.card) {
        setError(payload?.error ?? "查询失败，请稍后重试。");
        return;
      }
      setPreview(payload.card);
      setDialogOpen(true);
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(event: React.MouseEvent<HTMLButtonElement>) {
    if (!preview) {
      return;
    }
    event.preventDefault();
    setRedeeming(true);
    try {
      const response = await fetch("/api/console/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: preview.code }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redemption?: { planName: string; quotaTokens: number; validityDays: number };
        quota?: { balance: number };
      } | null;
      if (!response.ok || !payload?.redemption) {
        setDialogOpen(false);
        setError(payload?.error ?? "兑换失败，请稍后重试。");
        return;
      }
      const { planName, quotaTokens, validityDays } = payload.redemption;
      const balance = payload.quota?.balance;
      toast.success(
        `兑换成功：${planName}，+${formatTokens(quotaTokens)} 额度，有效期 ${validityDays} 天` +
          (balance === undefined ? "" : `，当前余额 ${formatTokens(balance)}`),
      );
      setDialogOpen(false);
      setPreview(null);
      setCode("");
      router.refresh();
    } catch {
      setDialogOpen(false);
      setError("网络错误，请稍后重试。");
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">兑换卡密</CardTitle>
        <CardDescription>兑换前会先显示卡密信息，确认后额度立即到账，有效期从当前有效期之后顺延。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={handleSubmit}>
          <div className="grid min-w-60 flex-1 gap-2">
            <Label htmlFor="card-code">卡密</Label>
            <Input
              id="card-code"
              required
              placeholder="MS-XXXXX-XXXXX-XXXXX"
              className="font-mono text-xs uppercase"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "查询中…" : "兑换"}
          </Button>
        </form>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
      </CardContent>

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认兑换此卡密？</AlertDialogTitle>
            <AlertDialogDescription>
              请核对以下卡密信息，兑换后不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview ? (
            <dl className="grid gap-2 rounded-md border bg-muted/40 p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">卡密</dt>
                <dd className="font-mono text-xs">{preview.code}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">套餐</dt>
                <dd>{preview.planName}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">额度</dt>
                <dd className="tabular-nums">+{formatTokens(preview.quotaTokens)}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">有效期</dt>
                <dd className="tabular-nums">{preview.validityDays} 天</dd>
              </div>
            </dl>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={redeeming}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={redeeming} onClick={handleConfirm}>
              {redeeming ? "兑换中…" : "确认兑换"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
