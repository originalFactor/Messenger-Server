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

import { useTranslator } from "@/components/i18n/locale-provider";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * 用户额度/角色调整面板（用户详情页内）。额度为多条目语义：
 * 正数充值生成新条目（可设有效天数），负数按先过期先用扣减，
 * 顺延作用于所有已设到期时间的未过期条目。保存后 router.refresh()
 * 重新拉取详情页的汇总与条目列表。
 */
export function UserAdjustPanel({
  userId,
  email,
  role,
  self,
}: {
  userId: string;
  email: string;
  role: "user" | "admin";
  self: boolean;
}) {
  const t = useTranslator();
  const router = useRouter();
  const [quotaDelta, setQuotaDelta] = useState("");
  const [validDays, setValidDays] = useState("");
  const [extendDays, setExtendDays] = useState("");
  const [nextRole, setNextRole] = useState<"user" | "admin">(role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const delta = quotaDelta.trim() === "" ? undefined : Number(quotaDelta);
    const grantedDays = validDays.trim() === "" ? undefined : Number(validDays);
    const days = extendDays.trim() === "" ? undefined : Number(extendDays);
    if (delta !== undefined && (!Number.isFinite(delta) || !Number.isInteger(delta))) {
      setError(t("额度增减必须是整数。"));
      return;
    }
    if (grantedDays !== undefined && (!Number.isFinite(grantedDays) || !Number.isInteger(grantedDays) || grantedDays < 0)) {
      setError(t("新条目有效天数必须是不小于 0 的整数。"));
      return;
    }
    if (days !== undefined && (!Number.isFinite(days) || !Number.isInteger(days) || days < 0)) {
      setError(t("有效期顺延天数必须是不小于 0 的整数。"));
      return;
    }
    const payload: Record<string, unknown> = {};
    if (delta !== undefined && delta !== 0) {
      payload.quotaDelta = delta;
      if (delta > 0 && grantedDays !== undefined && grantedDays > 0) {
        payload.quotaValidDays = grantedDays;
      }
    }
    if (days !== undefined && days > 0) {
      payload.quotaExtendDays = days;
    }
    if (!self && nextRole !== role) {
      payload.role = nextRole;
    }
    if (Object.keys(payload).length === 0) {
      setError(t("没有需要保存的变更。"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? t("保存失败，请稍后重试。"));
        return;
      }
      toast.success(t("已更新用户 {0}", { "0": email }));
      setQuotaDelta("");
      setValidDays("");
      setExtendDays("");
      router.refresh();
    } catch {
      setError(t("网络错误，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("调整")}</CardTitle>
        <CardDescription>
          {" "}{t("正数充值生成新条目（可设有效天数，留空 = 不限），负数按先过期先用扣减（下限 0）； 顺延作用于所有已设到期时间的未过期条目。")}{" "}{self ? t("（不能修改自己的角色）") : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-2">
            <Label htmlFor="user-quota-delta">{t("额度增减")}</Label>
            <Input
              id="user-quota-delta"
              inputMode="numeric"
              placeholder={t("如 100000 或 -50000")}
              className="font-mono text-xs tabular-nums"
              value={quotaDelta}
              onChange={(event) => setQuotaDelta(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="user-valid-days">{t("新条目有效天数")}</Label>
            <Input
              id="user-valid-days"
              inputMode="numeric"
              placeholder={t("留空 = 不限")}
              className="font-mono text-xs tabular-nums"
              value={validDays}
              onChange={(event) => setValidDays(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="user-extend-days">{t("有效期顺延（天）")}</Label>
            <Input
              id="user-extend-days"
              inputMode="numeric"
              placeholder={t("如 30")}
              className="font-mono text-xs tabular-nums"
              value={extendDays}
              onChange={(event) => setExtendDays(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="user-role">{t("角色")}</Label>
            <Select value={nextRole} onValueChange={(value) => setNextRole(value as "user" | "admin")} disabled={self}>
              <SelectTrigger id="user-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("用户")}</SelectItem>
                <SelectItem value="admin">{t("管理员")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
        <div className="mt-4 flex gap-2">
          <Button size="sm" disabled={busy} onClick={save}>
            {busy ? t("保存中…") : t("保存")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
