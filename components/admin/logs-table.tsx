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

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import type { RuntimeLogDoc, RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

const LEVEL_LABEL: Record<RuntimeLogLevel, string> = {
  error: "错误",
  warn: "警告",
  info: "信息",
};
const LEVEL_VARIANT: Record<RuntimeLogLevel, "destructive" | "default" | "secondary"> = {
  error: "destructive",
  warn: "default",
  info: "secondary",
};
const SOURCE_LABEL: Record<RuntimeLogSource, string> = {
  api: "API",
  relay: "中继",
  auth: "认证",
  billing: "计费",
  admin: "管理",
  sync: "同步",
  market: "市场",
  avatar: "头像",
  storage: "存储",
  migration: "迁移",
};

export interface LogsTableProps {
  rows: RuntimeLogDoc[];
  total: number;
  page: number;
  pageSize: number;
  /** 当前生效的筛选参数，翻页时一并带回 URL。 */
  level?: RuntimeLogLevel;
  source?: RuntimeLogSource;
  from?: string;
  to?: string;
}

/** 围绕当前页的连续页码窗口宽度（不含首尾固定按钮）；超出两侧用省略号折叠到首页/末页。 */
const PAGER_WINDOW = 7;

function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= PAGER_WINDOW) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const half = Math.floor(PAGER_WINDOW / 2);
  const start = Math.max(2, current - half);
  const end = Math.min(total - 1, current + half);
  const pages: (number | null)[] = [1];
  if (start > 2) {
    pages.push(null);
  }
  for (let p = start; p <= end; p += 1) {
    pages.push(p);
  }
  if (end < total - 1) {
    pages.push(null);
  }
  pages.push(total);
  return pages;
}

function pageHref(
  page: number,
  level: RuntimeLogLevel | undefined,
  source: RuntimeLogSource | undefined,
  from: string | undefined,
  to: string | undefined,
): string {
  const params = new URLSearchParams();
  if (level) {
    params.set("level", level);
  }
  if (source) {
    params.set("source", source);
  }
  if (from !== undefined) {
    params.set("from", from);
  }
  if (to !== undefined) {
    params.set("to", to);
  }
  params.set("page", String(page));
  return `/console/admin/logs?${params.toString()}`;
}

export function LogsTable({
  rows,
  total,
  page,
  pageSize,
  level,
  source,
  from,
  to,
}: LogsTableProps) {
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const pages = pageWindow(page, totalPages);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">系统运行日志</CardTitle>
        <CardDescription>
          每页 {pageSize} 条，按时间倒序；共 {total} 条 / {totalPages} 页。级别取日志严重度，来源取触发模块。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">所选筛选条件下暂无日志记录。</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>级别</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>方法</TableHead>
                  <TableHead>路径</TableHead>
                  <TableHead>摘要</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((log) => (
                  <TableRow key={log._id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(log.createdAt)}</TableCell>
                    <TableCell>
                      <Badge variant={LEVEL_VARIANT[log.level]}>
                        {LEVEL_LABEL[log.level]}
                      </Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{SOURCE_LABEL[log.source]}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {log.status ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {log.method ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground">
                      {log.path ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-72 truncate">{log.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}>
              <Link href={pageHref(Math.max(1, page - 1), level, source, from, to)} scroll={false} aria-disabled={page <= 1}>
                <ChevronLeft className="size-4" />
                上一页
              </Link>
            </Button>
            {pages.map((p, index) =>
              p === null ? (
                <span key={`gap-${index}`} className="px-2 text-sm text-muted-foreground">…</span>
              ) : (
                <Button
                  key={p}
                  asChild
                  size="sm"
                  variant={p === page ? "default" : "outline"}
                >
                  <Link href={pageHref(p, level, source, from, to)} scroll={false}>
                    {p}
                  </Link>
                </Button>
              ),
            )}
            <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
              <Link href={pageHref(Math.min(totalPages, page + 1), level, source, from, to)} scroll={false} aria-disabled={page >= totalPages}>
                下一页
                <ChevronRight className="size-4" />
              </Link>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
