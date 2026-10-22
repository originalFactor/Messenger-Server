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

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RuntimeLogLevel, RuntimeLogSource } from "@/lib/types";

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

/**
 * 表格行需要的全部内容。`details` 已在服务端渲染成文本：它可能是错误对象
 * 或任意自由结构，格式化放在 RSC 侧既避免了水合差异，也不把原始对象送过
 * 客户端边界。时间同理——浏览器时区与服务器不同，日期在服务端格式化。
 */
export interface LogRowView {
  id: string;
  timeLabel: string;
  level: RuntimeLogLevel;
  source: RuntimeLogSource;
  message: string;
  /** 触发日志的请求方法；非 HTTP 来源为 null。 */
  method: string | null;
  /** 触发日志的请求路径；非 HTTP 来源为 null。 */
  path: string | null;
  /** HTTP 状态码；非 HTTP 来源为 null。 */
  status: number | null;
  /** 预格式化的 `details` JSON。 */
  detailsText: string;
}

/**
 * 日志明细表 + 单条详情模态窗。
 *
 * 列表只留「时间 / 级别 / 来源 / 摘要」四列：方法、路径、状态码对绝大多数
 * 非 HTTP 日志恒为 `—`，占着列宽却几乎不携带信息。它们与原始 `details`
 * 一起收进点击行后的详情窗，需要时一次看全。
 */
export function LogDetailTable({ rows }: { rows: LogRowView[] }) {
  // 翻页/换筛选后 `rows` 整批换掉，但组件实例留在原位；把页码指纹一起存进
  // 状态，指纹不匹配就当作未打开——否则模态窗会继续展示上一页那条日志。
  const rowsKey = rows.map((log) => log.id).join(",");
  const [active, setActive] = useState<{ key: string; log: LogRowView } | null>(null);
  const opened = active && active.key === rowsKey ? active.log : null;

  async function copyDetails(log: LogRowView) {
    try {
      await navigator.clipboard.writeText(
        `${log.timeLabel} [${LEVEL_LABEL[log.level]}/${SOURCE_LABEL[log.source]}] ${log.message}\n\n${log.detailsText}`,
      );
      toast.success("日志详情已复制");
    } catch {
      toast.error("复制失败，请手动选择文本。");
    }
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">时间</TableHead>
              <TableHead className="w-20">级别</TableHead>
              <TableHead className="w-20">来源</TableHead>
              <TableHead>摘要</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((log) => (
              <TableRow
                key={log.id}
                className="cursor-pointer hover:bg-muted/50 has-[button:focus-visible]:bg-muted/50"
                onClick={() => setActive({ key: rowsKey, log })}
              >
                <TableCell className="whitespace-nowrap tabular-nums">{log.timeLabel}</TableCell>
                <TableCell>
                  <Badge variant={LEVEL_VARIANT[log.level]}>{LEVEL_LABEL[log.level]}</Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">{SOURCE_LABEL[log.source]}</TableCell>
                <TableCell className="max-w-96">
                  {/* 行点击只服务指针；键盘/读屏走这个真实按钮（点击冒泡到行，
                      不会重复触发），表格行因此保留 tr 语义。 */}
                  <button
                    type="button"
                    title={log.message}
                    aria-label={`查看日志详情：${log.message}`}
                    className="block w-full truncate text-left focus-visible:underline focus-visible:underline-offset-4 focus-visible:outline-none"
                  >
                    {log.message}
                  </button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={opened !== null} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent className="max-h-[calc(100vh-6rem)] overflow-y-auto sm:max-w-3xl">
          {opened ? (
            <>
              <DialogHeader className="pr-8">
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <Badge variant={LEVEL_VARIANT[opened.level]}>{LEVEL_LABEL[opened.level]}</Badge>
                  <span>{SOURCE_LABEL[opened.source]}</span>
                  <span className="text-sm font-normal text-muted-foreground tabular-nums">
                    {opened.timeLabel}
                  </span>
                </DialogTitle>
                <DialogDescription className="break-words">{opened.message}</DialogDescription>
              </DialogHeader>

              <dl className="grid gap-2 text-sm sm:grid-cols-[6rem_1fr]">
                <dt className="text-muted-foreground">方法</dt>
                <dd className="font-mono text-xs">{opened.method ?? "—"}</dd>
                <dt className="text-muted-foreground">路径</dt>
                <dd className="break-all font-mono text-xs">{opened.path ?? "—"}</dd>
                <dt className="text-muted-foreground">状态码</dt>
                <dd className="font-mono text-xs tabular-nums">{opened.status ?? "—"}</dd>
                <dt className="text-muted-foreground">记录 ID</dt>
                <dd className="break-all font-mono text-xs">{opened.id}</dd>
              </dl>

              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">原始上下文</span>
                  <Button variant="outline" size="sm" onClick={() => copyDetails(opened)}>
                    复制
                  </Button>
                </div>
                <pre className="max-h-80 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                  {opened.detailsText}
                </pre>
              </div>

              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline">关闭</Button>
                </DialogClose>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
