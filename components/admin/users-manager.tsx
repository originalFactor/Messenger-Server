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
import Link from "next/link";
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

export function UsersManager({ users }: { users: AdminUserView[] }) {
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) {
      return users;
    }
    return users.filter((user) => user.email.toLowerCase().includes(keyword));
  }, [users, filter]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">用户列表（{users.length}）</CardTitle>
        <CardDescription>
          用户可同时持有多个套餐条目，各自额度与有效期独立计算；列表显示未过期条目的汇总。
          额度与角色调整在用户详情页内进行。
        </CardDescription>
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
                  <TableHead className="w-16">条目</TableHead>
                  <TableHead className="w-44">有效期至</TableHead>
                  <TableHead className="w-44">注册时间</TableHead>
                  <TableHead className="w-44">最近登录</TableHead>
                  <TableHead className="w-20 text-right">操作</TableHead>
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
                    <TableCell className="tabular-nums">{user.activeQuotaCount}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {user.quotaUnlimited
                        ? "不限"
                        : user.quotaExpiresAt
                          ? formatDateTime(user.quotaExpiresAt)
                          : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatDateTime(user.createdAt)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" asChild>
                        <Link href={`/console/admin/users/${user._id}`}>详情</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
