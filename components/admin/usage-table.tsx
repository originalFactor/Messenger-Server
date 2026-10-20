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
import { formatDateTime, formatTokens, formatTps } from "@/lib/format";
import type { AdminUsageRow } from "@/lib/types";

export interface UsageTableProps {
  rows: AdminUsageRow[];
  /** 所选范围内符合过滤的调用总数。 */
  total: number;
  /** 当前页码（从 1 开始）。 */
  page: number;
  /** 页大小。 */
  pageSize: number;
  /**
   * 当前时间范围描述：preset 取 `24h`/`7d`/`30d` 之一；自定义起止日期取
   * `custom`。分页器翻页时把当前过滤条件（range 或 from/to）一并带回 URL。
   */
  range: string;
  /** 自定义开始日期（YYYY-MM-DD），预设模式下为 undefined。 */
  from?: string;
  /** 自定义结束日期（YYYY-MM-DD），预设模式下为 undefined。 */
  to?: string;
  /** 显示「调用方账号」列；管理后台为 true（默认），用户概览页传入 false。 */
  showCallerColumn?: boolean;
  /** 显示「上游」列；管理后台为 true（默认），用户概览页传入 false。 */
  showUpstreamColumn?: boolean;
}

/** 围绕当前页的连续页码窗口宽度（不含首尾固定按钮）；超出两侧用省略号折叠到首页/末页。 */
const PAGER_WINDOW = 7;

/**
 * 围绕当前页生成要显示的页码：总页数 ≤ 窗口时全显；否则当前页居中开一个
 * 窗口，窗口外用 `null` 占位表示省略号，首尾页固定显示以便跳转。
 */
function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= PAGER_WINDOW) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const half = Math.floor(PAGER_WINDOW / 2);
  let start = current - half;
  let end = current + half;
  if (start < 1) {
    start = 1;
    end = PAGER_WINDOW;
  } else if (end > total) {
    end = total;
    start = total - PAGER_WINDOW + 1;
  }
  const pages: (number | null)[] = [];
  if (start > 1) {
    pages.push(1);
    if (start > 2) {
      pages.push(null);
    }
  }
  for (let p = start; p <= end; p += 1) {
    pages.push(p);
  }
  if (end < total) {
    if (end < total - 1) {
      pages.push(null);
    }
    pages.push(total);
  }
  return pages;
}

function pageHref(range: string, page: number, from: string | undefined, to: string | undefined, basePath: string): string {
  const params = new URLSearchParams();
  if (from !== undefined || to !== undefined) {
    if (from !== undefined) {
      params.set("from", from);
    }
    if (to !== undefined) {
      params.set("to", to);
    }
  } else {
    params.set("range", range);
  }
  params.set("page", String(page));
  return `${basePath}?${params.toString()}`;
}

export function UsageTable({
  rows,
  total,
  page,
  pageSize,
  range,
  from,
  to,
  showCallerColumn = true,
  showUpstreamColumn = true,
  title = "全站近期调用",
  description = "每页 {pageSize} 条，按调用时间倒序；共 {total} 条 / {totalPages} 页。调用方账号取用户邮箱，TPS 由输出 tokens ÷ 耗时换算。",
  basePath = "/console/admin/usage",
}: UsageTableProps & {
  title?: string;
  description?: string;
  basePath?: string;
}) {
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  const pages = pageWindow(page, totalPages);
  const summary = description
    .replace("{pageSize}", String(pageSize))
    .replace("{total}", String(total))
    .replace("{totalPages}", String(totalPages));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{summary}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">该时间范围内暂无调用记录。</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  {showCallerColumn ? <TableHead>调用方账号</TableHead> : null}
                  <TableHead>模型</TableHead>
                  {showUpstreamColumn ? <TableHead>上游</TableHead> : null}
                  <TableHead>输入（未缓存）</TableHead>
                  <TableHead>缓存读取</TableHead>
                  <TableHead>输出</TableHead>
                  <TableHead>TPS</TableHead>
                  <TableHead className="text-right">额度</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((log) => {
                  // 上游被删（upstreamName 缺失）时不再回退显示裸 id，
                  // 统一显示「已删除」让运维一眼分辨；无 upstreamId 的老记录用「—」。
                  const upstreamLabel = log.upstreamId
                    ? (log.upstreamName ?? "已删除")
                    : "—";
                  return (
                    <TableRow key={log._id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(log.createdAt)}</TableCell>
                      {showCallerColumn ? (
                        <TableCell className="max-w-52 truncate">{log.email ?? "—"}</TableCell>
                      ) : null}
                      <TableCell className="font-mono text-xs">{log.modelId}</TableCell>
                      {showUpstreamColumn ? (
                        <TableCell className="max-w-40 truncate">{upstreamLabel}</TableCell>
                      ) : null}
                      <TableCell className="tabular-nums">{formatTokens(log.promptTokens)}</TableCell>
                      <TableCell className="tabular-nums">{formatTokens(log.cachedTokens ?? 0)}</TableCell>
                      <TableCell className="tabular-nums">{formatTokens(log.completionTokens)}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatTps(log.completionTokens, log.durationMs)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{log.cost}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {totalPages > 1 ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-1">
            <Button asChild variant="outline" size="sm" disabled={page <= 1}>
              <Link href={pageHref(range, Math.max(1, page - 1), from, to, basePath)} scroll={false} aria-disabled={page <= 1}>
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
                  <Link href={pageHref(range, p, from, to, basePath)} scroll={false}>
                    {p}
                  </Link>
                </Button>
              ),
            )}
            <Button asChild variant="outline" size="sm" disabled={page >= totalPages}>
              <Link href={pageHref(range, Math.min(totalPages, page + 1), from, to, basePath)} scroll={false} aria-disabled={page >= totalPages}>
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
