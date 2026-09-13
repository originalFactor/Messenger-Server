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

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Plus } from "lucide-react";
import { toast } from "sonner";
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
import { formatDateTime, formatTokens } from "@/lib/format";
import type { CardKeyDoc, PlanDoc } from "@/lib/types";

const statusLabels: Record<CardKeyDoc["status"], string> = {
  unused: "未使用",
  redeemed: "已兑换",
  disabled: "已停用",
};

export function CardsManager({ plans }: { plans: PlanDoc[] }) {
  const router = useRouter();
  const [planId, setPlanId] = useState(plans[0]?._id ?? "");
  const [count, setCount] = useState("10");
  const [note, setNote] = useState("");
  const [issuing, setIssuing] = useState(false);
  const [issued, setIssued] = useState<CardKeyDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<"all" | CardKeyDoc["status"]>("all");
  const [cards, setCards] = useState<CardKeyDoc[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);

  const loadCards = useCallback(async () => {
    setLoadingCards(true);
    try {
      const query = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const response = await fetch(`/api/admin/cards${query}`);
      if (response.ok) {
        const payload = (await response.json()) as { cards: CardKeyDoc[] };
        setCards(payload.cards);
      }
    } finally {
      setLoadingCards(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  async function issue(event: React.FormEvent) {
    event.preventDefault();
    setIssuing(true);
    setError(null);
    setIssued(null);
    try {
      const response = await fetch("/api/admin/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, count: Number(count), note: note || null }),
      });
      const payload = (await response.json().catch(() => null)) as { cards?: CardKeyDoc[]; error?: string } | null;
      if (!response.ok || !payload?.cards) {
        setError(payload?.error ?? "开卡失败，请稍后重试。");
        return;
      }
      setIssued(payload.cards);
      toast.success(`成功生成 ${payload.cards.length} 张卡密`);
      await loadCards();
      router.refresh();
    } catch {
      setError("网络错误，请稍后重试。");
    } finally {
      setIssuing(false);
    }
  }

  async function copyIssued() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.map((card) => card.code).join("\n"));
      toast.success("已复制全部卡密");
    } catch {
      setError("复制失败，请手动选择复制。");
    }
  }

  async function disableCard(card: CardKeyDoc) {
    setActionBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${card._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "disabled" }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "停用失败。");
        return;
      }
      await loadCards();
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteCard(card: CardKeyDoc) {
    if (!window.confirm(`确定删除卡密 ${card.code}？`)) {
      return;
    }
    setActionBusy(true);
    try {
      const response = await fetch(`/api/admin/cards/${card._id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "删除失败。");
        return;
      }
      await loadCards();
    } finally {
      setActionBusy(false);
    }
  }

  function statusBadge(status: CardKeyDoc["status"]) {
    if (status === "unused") {
      return (
        <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" variant="secondary">
          未使用
        </Badge>
      );
    }
    if (status === "disabled") {
      return <Badge variant="destructive">已停用</Badge>;
    }
    return <Badge variant="secondary">已兑换</Badge>;
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">批量开卡</CardTitle>
          <CardDescription>卡密内嵌创建时刻的套餐快照，之后修改或删除套餐不影响已开出的卡。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {plans.length === 0 ? (
            <p className="text-sm text-muted-foreground">请先在「套餐管理」中创建套餐。</p>
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={issue}>
              <div className="grid min-w-52 gap-2">
                <Label htmlFor="issue-plan">套餐</Label>
                <Select value={planId} onValueChange={setPlanId}>
                  <SelectTrigger id="issue-plan" className="w-full">
                    <SelectValue placeholder="选择套餐" />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((plan) => (
                      <SelectItem key={plan._id} value={plan._id}>
                        {plan.name}（{formatTokens(plan.quotaTokens)} / {plan.validityDays} 天）
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issue-count">数量（1-500）</Label>
                <Input
                  id="issue-count"
                  type="number"
                  min={1}
                  max={500}
                  required
                  className="w-28"
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                />
              </div>
              <div className="grid min-w-52 flex-1 gap-2">
                <Label htmlFor="issue-note">备注（选填）</Label>
                <Input id="issue-note" value={note} onChange={(event) => setNote(event.target.value)} />
              </div>
              <Button type="submit" disabled={issuing}>
                <Plus />
                {issuing ? "开卡中…" : "生成卡密"}
              </Button>
            </form>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {issued ? (
            <div className="grid gap-3 rounded-lg border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  成功生成 {issued.length} 张卡密（请立即保存，仅此次完整展示）：
                </p>
                <Button variant="outline" size="sm" onClick={copyIssued}>
                  <Copy />
                  复制全部
                </Button>
              </div>
              <div className="max-h-44 overflow-y-auto font-mono text-xs leading-relaxed">
                {issued.map((card) => (
                  <div key={card._id}>{card.code}</div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="grid gap-1.5">
            <CardTitle className="text-base">卡密列表</CardTitle>
            <CardDescription>最近 50 张。</CardDescription>
          </div>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | CardKeyDoc["status"])}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              <SelectItem value="unused">未使用</SelectItem>
              <SelectItem value="redeemed">已兑换</SelectItem>
              <SelectItem value="disabled">已停用</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {loadingCards ? (
            <p className="py-6 text-center text-sm text-muted-foreground">加载中…</p>
          ) : cards.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">没有符合条件的卡密。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>卡密</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>额度</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>备注</TableHead>
                  <TableHead>创建时间</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cards.map((card) => (
                  <TableRow key={card._id}>
                    <TableCell className="font-mono text-xs">{card.code}</TableCell>
                    <TableCell>{card.planName}</TableCell>
                    <TableCell className="tabular-nums">{formatTokens(card.quotaTokens)}</TableCell>
                    <TableCell>{statusBadge(card.status)}</TableCell>
                    <TableCell className="text-muted-foreground">{card.note || "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(card.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        {card.status === "unused" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() => disableCard(card)}
                          >
                            停用
                          </Button>
                        ) : null}
                        {card.status !== "redeemed" ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={actionBusy}
                            onClick={() => deleteCard(card)}
                          >
                            删除
                          </Button>
                        ) : null}
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
