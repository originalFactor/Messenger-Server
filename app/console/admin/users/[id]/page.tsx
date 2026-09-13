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

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdminUser } from "@/lib/auth";
import { formatDateTime, formatTokens } from "@/lib/format";
import { getUserById, getUserQuotaState, listUserQuotaEntitlements } from "@/lib/storage";
import type { UserQuotaDoc } from "@/lib/types";

export const dynamic = "force-dynamic";

const sourceLabels: Record<UserQuotaDoc["source"], string> = {
  card: "卡密兑换",
  admin: "管理员授予",
  migrated: "存量迁移",
};

/** 数据装配放在组件外的普通函数里，避免在渲染期间直接调用 Date.now()。 */
async function loadUserDetail(userId: string) {
  const [user, entitlements, quota] = await Promise.all([
    getUserById(userId),
    listUserQuotaEntitlements(userId),
    getUserQuotaState(userId),
  ]);
  return { user, entitlements, quota, now: Date.now() };
}

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
  }

  const { id } = await params;
  const { user, entitlements, quota, now } = await loadUserDetail(id);
  if (!user) {
    redirect("/console/admin/users");
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" asChild>
          <Link href="/console/admin/users" aria-label="返回用户列表">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-xl font-semibold tracking-tight break-all">{user.email}</h1>
        <Badge variant={user.role === "admin" ? "default" : "secondary"}>
          {user.role === "admin" ? "管理员" : "用户"}
        </Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">可用额度</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{formatTokens(quota.balance)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {quota.available
              ? quota.expiresAt === null
                ? "有效期不限"
                : `最晚至 ${formatDateTime(quota.expiresAt)}`
              : quota.reason === "expired"
                ? "全部套餐已过期"
                : "暂无可用额度"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">未过期条目</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">
              {entitlements.filter((entry) => entry.expiresAt === null || entry.expiresAt > now).length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">共 {entitlements.length} 条</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">注册时间</CardDescription>
            <CardTitle className="text-base tracking-tight tabular-nums">{formatDateTime(user.createdAt)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">用户 ID {user.id}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">最近登录</CardDescription>
            <CardTitle className="text-base tracking-tight tabular-nums">
              {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">按条目独立计有效期</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">套餐条目</CardTitle>
          <CardDescription>
            每次卡密兑换 / 管理员授予各产生一条条目，额度与有效期独立计算；消耗按先过期先用扣减。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entitlements.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">该用户还没有套餐条目。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>获得时间</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>套餐</TableHead>
                  <TableHead>剩余额度</TableHead>
                  <TableHead>有效期至</TableHead>
                  <TableHead className="text-right">状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entitlements.map((entry) => {
                  const active = entry.expiresAt === null || entry.expiresAt > now;
                  return (
                    <TableRow key={entry._id}>
                      <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(entry.createdAt)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{sourceLabels[entry.source] ?? entry.source}</Badge>
                      </TableCell>
                      <TableCell>{entry.planName ?? "—"}</TableCell>
                      <TableCell className="tabular-nums">{formatTokens(entry.balance)}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {entry.expiresAt === null ? "不限" : formatDateTime(entry.expiresAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        {active ? (
                          <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" variant="secondary">
                            生效中
                          </Badge>
                        ) : (
                          <Badge variant="secondary">已过期</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
