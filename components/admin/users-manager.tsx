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

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
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
import type { AdminUserView } from "@/lib/types";

export function UsersManager({ users, currentUserId }: { users: AdminUserView[]; currentUserId: string }) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [quotaDelta, setQuotaDelta] = useState("");
  const [extendDays, setExtendDays] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) {
      return users;
    }
    return users.filter((user) => user.email.toLowerCase().includes(keyword));
  }, [users, filter]);

  function startEdit(user: AdminUserView) {
    setEditingId(user._id);
    setQuotaDelta("");
    setExtendDays("");
    setRole(user.role);
    setError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setError(null);
  }

  async function save(user: AdminUserView) {
    const delta = quotaDelta.trim() === "" ? undefined : Number(quotaDelta);
    const days = extendDays.trim() === "" ? undefined : Number(extendDays);
    if (delta !== undefined && (!Number.isFinite(delta) || !Number.isInteger(delta))) {
      setError("额度增减必须是整数。");
      return;
    }
    if (days !== undefined && (!Number.isFinite(days) || !Number.isInteger(days) || days < 0)) {
      setError("有效期顺延天数必须是不小于 0 的整数。");
      return;
    }
    const payload: Record<string, unknown> = {};
    if (delta !== undefined && delta !== 0) {
      payload.quotaDelta = delta;
    }
    if (days !== undefined && days > 0) {
      payload.quotaExtendDays = days;
    }
    if (user._id !== currentUserId && role !== user.role) {
      payload.role = role;
    }
    if (Object.keys(payload).length === 0) {
      cancelEdit();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/users/${user._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setError(body?.error ?? "保存失败，请稍后重试。");
        return;
      }
      toast.success(`已更新用户 ${user.email}`);
      setEditingId(null);
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
        <CardTitle className="text-base">用户列表（{users.length}）</CardTitle>
        <CardDescription>调整额度为增减操作（正数充值、负数扣减，下限 0）；有效期顺延与卡密兑换同语义。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4">
          <Input
            placeholder="按邮箱搜索"
            className="max-w-64"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {users.length === 0 ? "还没有注册用户。" : "没有匹配的用户。"}
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邮箱</TableHead>
                  <TableHead className="w-20">角色</TableHead>
                  <TableHead className="w-28">额度</TableHead>
                  <TableHead className="w-44">有效期至</TableHead>
                  <TableHead className="w-44">注册时间</TableHead>
                  <TableHead className="w-44">最近登录</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((user) => (
                  <TableRow key={user._id}>
                    <TableCell className="max-w-56 break-all">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                        {user.role === "admin" ? "管理员" : "用户"}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{formatTokens(user.quotaBalance)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {user.quotaExpiresAt ? formatDateTime(user.quotaExpiresAt) : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(user.createdAt)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" disabled={editingId === user._id} onClick={() => startEdit(user)}>
                        调整
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {editingId ? (
          (() => {
            const user = users.find((entry) => entry._id === editingId);
            if (!user) {
              return null;
            }
            const self = user._id === currentUserId;
            return (
              <div className="mt-4 grid gap-3 rounded-lg border bg-muted/40 p-4">
                <p className="text-sm font-medium">
                  调整 {user.email}
                  {self ? <span className="ml-2 text-xs text-muted-foreground">（不能修改自己的角色）</span> : null}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="user-quota-delta">额度增减</Label>
                    <Input
                      id="user-quota-delta"
                      inputMode="numeric"
                      placeholder="如 100000 或 -50000"
                      className="font-mono text-xs tabular-nums"
                      value={quotaDelta}
                      onChange={(event) => setQuotaDelta(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="user-extend-days">有效期顺延（天）</Label>
                    <Input
                      id="user-extend-days"
                      inputMode="numeric"
                      placeholder="如 30"
                      className="font-mono text-xs tabular-nums"
                      value={extendDays}
                      onChange={(event) => setExtendDays(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="user-role">角色</Label>
                    <Select value={role} onValueChange={(value) => setRole(value as "user" | "admin")} disabled={self}>
                      <SelectTrigger id="user-role" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">用户</SelectItem>
                        <SelectItem value="admin">管理员</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {error ? <p className="text-sm text-destructive">{error}</p> : null}
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => save(user)}>
                    保存
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={cancelEdit}>
                    取消
                  </Button>
                </div>
              </div>
            );
          })()
        ) : null}
      </CardContent>
    </Card>
  );
}
