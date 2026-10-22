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
import { LogDetailTable } from "@/components/admin/log-detail-table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { RuntimeLogDoc, RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

/**
 * `details` 是自由结构（错误对象、上下文、任意值），这里统一折成缩进 JSON。
 * 空值渲染成 `—`，非 JSON 可序列化的兜底为 `String(value)`。字符串值先去掉
 * 控制台捕获留下的 SGR 转义，否则模态窗里只剩一串 `\u001b[36m` 噪声。
 */
function formatLogDetails(details: unknown): string {
  if (details === null || details === undefined) {
    return "—";
  }
  try {
    return JSON.stringify(
      details,
      (_key, value) => (typeof value === "string" ? stripAnsi(value) : value),
      2,
    );
  } catch {
    return String(details);
  }
}

/**
 * 控制台捕获保留了终端的 SGR 颜色转义（`ESC[32m` 等），在浏览器里只会显示成
 * 一串 `[36m[39m` 噪声：摘要与 `details` 文本都先去掉。`runtime_logs` 里的
 * 原始字符串不动，日志页只是渲染层做清洗。
 */
function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

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
          每页 {pageSize} 条，按时间倒序；共 {total} 条 / {totalPages} 页。级别取日志严重度，来源取触发模块；
          点击任意一行查看方法、路径、状态码与原始上下文。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">所选筛选条件下暂无日志记录。</p>
        ) : (
          // 表格与详情模态窗在客户端组件里（行点击要状态）；这里只做服务端
          // 的格式化：时间按服务器时区渲染，`details` 折成文本后再过边界。
          <LogDetailTable
            rows={rows.map((log) => ({
              id: log._id,
              timeLabel: formatDateTime(log.createdAt),
              level: log.level,
              source: log.source,
              message: stripAnsi(log.message),
              method: log.method,
              path: log.path,
              status: log.status,
              detailsText: formatLogDetails(log.details),
            }))}
          />
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
