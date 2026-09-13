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

import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
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
import { getSiteOverview, getSyncOverview } from "@/lib/storage";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  const admin = await requireAdminUser();
  if (!admin) {
    redirect("/console");
  }

  const [overview, sync] = await Promise.all([getSiteOverview(), getSyncOverview()]);

  return (
    <div className="grid gap-6">
      <h1 className="text-xl font-semibold tracking-tight">全站概览</h1>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">用户总数</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{overview.users.total}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            管理员 {overview.users.admins} · 近 24h 新增 {overview.users.newToday}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">近 24h 用量</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{overview.usage.today.requests}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {formatTokens(overview.usage.today.tokens)} tokens · 消耗 {formatTokens(overview.usage.today.cost)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">近 7 天用量</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{overview.usage.week.requests}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {formatTokens(overview.usage.week.tokens)} tokens · 消耗 {formatTokens(overview.usage.week.cost)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">卡密</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{overview.cards.total}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            未用 {overview.cards.unused} · 已用 {overview.cards.redeemed} · 停用 {overview.cards.disabled}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">套餐</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">
              {overview.plans.enabled}/{overview.plans.total}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">启用中 / 总数</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">上游</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">
              {overview.upstreams.enabled}/{overview.upstreams.total}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">启用中 / 总数</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">Messenger Sync</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{formatTokens(sync.conversations)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            同步用户 {sync.syncUsers} · 会话 · 智能体 {formatTokens(sync.agents)} · 服务商 {formatTokens(sync.providers)} ·
            消息 {formatTokens(sync.messages)}
            {sync.lastSyncAt ? ` · 最近同步 ${formatDateTime(sync.lastSyncAt)}` : ""}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">最新注册用户</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.recentUsers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无用户。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>邮箱</TableHead>
                    <TableHead>角色</TableHead>
                    <TableHead className="text-right">注册时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.recentUsers.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="max-w-52 truncate">{user.email}</TableCell>
                      <TableCell>
                        <Badge variant={user.role === "admin" ? "default" : "secondary"}>
                          {user.role === "admin" ? "管理员" : "用户"}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right text-muted-foreground">
                        {formatDateTime(user.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">全站近期调用</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.recentUsage.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">暂无调用记录。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>tokens</TableHead>
                    <TableHead className="text-right">额度</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.recentUsage.map((log) => (
                    <TableRow key={log._id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(log.createdAt)}</TableCell>
                      <TableCell className="font-mono text-xs">{log.modelId}</TableCell>
                      <TableCell className="tabular-nums">{formatTokens(log.totalTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{log.cost}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
