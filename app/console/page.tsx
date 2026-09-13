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
import { ApiKeyCard } from "@/components/console/api-key-card";
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
import { requireUserSession } from "@/lib/auth";
import { formatDateTime, formatTokens } from "@/lib/format";
import { quotaState } from "@/lib/quota";
import { getUserById, listUsageLogs, sumUsage } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** 数据装配放在组件外的普通函数里，避免在渲染期间直接调用 Date.now()。 */
async function loadOverviewData(userId: string, balance: number, expiresAt: number | null) {
  const now = Date.now();
  const [today, recentUsage] = await Promise.all([
    sumUsage(userId, now - 24 * 60 * 60 * 1000),
    listUsageLogs(userId, 10),
  ]);
  return { today, recentUsage, quota: quotaState(balance, expiresAt, now) };
}

export default async function ConsoleOverviewPage() {
  const session = await requireUserSession();
  if (!session) {
    redirect("/login");
  }
  const user = await getUserById(session.sub);
  if (!user) {
    redirect("/login");
  }

  const { today, recentUsage, quota } = await loadOverviewData(
    user.id,
    user.quotaBalance,
    user.quotaExpiresAt,
  );

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">概览</h1>
        <Badge variant="outline">{user.role === "admin" ? "管理员" : "用户"}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">剩余额度</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">
              {formatTokens(quota.balance)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {quota.available
              ? `有效期至 ${formatDateTime(quota.expiresAt ?? 0)}`
              : quota.reason === "expired"
                ? "套餐已过期，请兑换新卡密"
                : "暂无可用额度，请兑换卡密"}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">近 24 小时请求</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{today.requests}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            消耗 {formatTokens(today.cost)} 额度
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription className="font-mono text-xs uppercase tracking-wider">近 24 小时 tokens</CardDescription>
            <CardTitle className="text-2xl tracking-tighter tabular-nums">{formatTokens(today.tokens)}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">按模型倍率折算</CardContent>
        </Card>
      </div>

      <ApiKeyCard apiKey={user.aiApiKey} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">近期用量</CardTitle>
          <CardDescription>
            在 Messenger 中使用 Messenger Cloud AI 服务商发起对话后，这里会展示明细。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {recentUsage.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">暂无调用记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>输入</TableHead>
                  <TableHead>输出</TableHead>
                  <TableHead>消耗额度</TableHead>
                  <TableHead className="text-right">方式</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentUsage.map((log) => (
                  <TableRow key={log._id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(log.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{log.modelId}</TableCell>
                    <TableCell className="tabular-nums">{formatTokens(log.promptTokens)}</TableCell>
                    <TableCell className="tabular-nums">{formatTokens(log.completionTokens)}</TableCell>
                    <TableCell className="tabular-nums">{log.cost}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {log.stream ? "流式" : "非流式"}
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
