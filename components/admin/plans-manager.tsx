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
import { Plus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatTokens } from "@/lib/format";
import type { PlanDoc } from "@/lib/types";

interface PlanFormState {
  name: string;
  description: string;
  quotaTokens: string;
  validityDays: string;
  price: string;
  enabled: string;
  sortOrder: string;
}

const emptyForm: PlanFormState = {
  name: "",
  description: "",
  quotaTokens: "",
  validityDays: "",
  price: "",
  enabled: "1",
  sortOrder: "0",
};

export function PlansManager({ plans }: { plans: PlanDoc[] }) {
  const t = useTranslator();
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PlanFormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
    setError(null);
  }

  function startEdit(plan: PlanDoc) {
    setEditingId(plan._id);
    setForm({
      name: plan.name,
      description: plan.description ?? "",
      quotaTokens: String(plan.quotaTokens),
      validityDays: String(plan.validityDays),
      price: plan.price ?? "",
      enabled: plan.enabled ? "1" : "0",
      sortOrder: String(plan.sortOrder),
    });
    setShowForm(true);
    setError(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const payload = {
      name: form.name,
      description: form.description || null,
      quotaTokens: Number(form.quotaTokens),
      validityDays: Number(form.validityDays),
      price: form.price || null,
      enabled: form.enabled === "1",
      sortOrder: Number(form.sortOrder) || 0,
    };
    if (!Number.isFinite(payload.quotaTokens) || payload.quotaTokens <= 0) {
      setError(t("额度必须是正整数。"));
      return;
    }
    if (!Number.isFinite(payload.validityDays) || payload.validityDays <= 0) {
      setError(t("有效天数必须是正整数。"));
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(editingId ? `/api/admin/plans/${editingId}` : "/api/admin/plans", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? t("保存失败，请稍后重试。"));
        return;
      }
      setShowForm(false);
      router.refresh();
    } catch {
      setError(t("网络错误，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(plan: PlanDoc) {
    if (!window.confirm(t("确定删除套餐「{0}」？已发出的卡密仍可按开出时的内容兑换。", { "0": plan.name }))) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/plans/${plan._id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? t("删除失败。"));
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div>
        <Button onClick={startCreate}>
          <Plus />
          {" "}{t("新建套餐")}{" "}
        </Button>
      </div>

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{editingId ? t("编辑套餐") : t("新建套餐")}</CardTitle>
            <CardDescription>
              {" "}{t("额度在兑换时一次性充入；有效期自兑换时刻（或现有有效期之后）起算。")}{" "}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form className="grid gap-4" onSubmit={submit}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="grid gap-2">
                  <Label htmlFor="plan-name">{t("名称")}</Label>
                  <Input
                    id="plan-name"
                    required
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-quota">{t("额度（tokens）")}</Label>
                  <Input
                    id="plan-quota"
                    required
                    type="number"
                    min={1}
                    value={form.quotaTokens}
                    onChange={(event) => setForm({ ...form, quotaTokens: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-validity">{t("有效期（天）")}</Label>
                  <Input
                    id="plan-validity"
                    required
                    type="number"
                    min={1}
                    value={form.validityDays}
                    onChange={(event) => setForm({ ...form, validityDays: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-price">{t("价格文案（选填）")}</Label>
                  <Input
                    id="plan-price"
                    placeholder="￥9.9"
                    value={form.price}
                    onChange={(event) => setForm({ ...form, price: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-sort">{t("排序")}</Label>
                  <Input
                    id="plan-sort"
                    type="number"
                    min={0}
                    value={form.sortOrder}
                    onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-enabled">{t("启用")}</Label>
                  <Select value={form.enabled} onValueChange={(value) => setForm({ ...form, enabled: value })}>
                    <SelectTrigger id="plan-enabled" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">{t("启用")}</SelectItem>
                      <SelectItem value="0">{t("停用")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor="plan-desc">{t("描述（选填）")}</Label>
                  <Input
                    id="plan-desc"
                    value={form.description}
                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                  />
                </div>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {editingId ? t("保存") : t("创建")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                  {" "}{t("取消")}{" "}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          {plans.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {" "}{t("还没有套餐，点击「新建套餐」创建第一个。")}{" "}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("名称")}</TableHead>
                  <TableHead>{t("额度")}</TableHead>
                  <TableHead>{t("有效期")}</TableHead>
                  <TableHead>{t("价格文案")}</TableHead>
                  <TableHead>{t("排序")}</TableHead>
                  <TableHead>{t("状态")}</TableHead>
                  <TableHead className="text-right">{t("操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plans.map((plan) => (
                  <TableRow key={plan._id}>
                    <TableCell>
                      <div className="font-medium">{plan.name}</div>
                      {plan.description ? (
                        <div className="text-xs text-muted-foreground">{plan.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatTokens(plan.quotaTokens, t.locale)}</TableCell>
                    <TableCell className="tabular-nums">{plan.validityDays} {" "}{t("天")}</TableCell>
                    <TableCell>{plan.price || "—"}</TableCell>
                    <TableCell className="tabular-nums">{plan.sortOrder}</TableCell>
                    <TableCell>
                      <Badge variant={plan.enabled ? "default" : "secondary"}>
                        {plan.enabled ? t("启用") : t("停用")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => startEdit(plan)}>
                          {" "}{t("编辑")}{" "}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => remove(plan)} disabled={busy}>
                          {" "}{t("删除")}{" "}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
