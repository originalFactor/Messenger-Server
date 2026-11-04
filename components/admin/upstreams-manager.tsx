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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, ArrowDownToLine, ChevronsUpDown, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatPeakWindows, parsePeakWindows } from "@/lib/pricing";
import { catalogModelDefault, rankCatalogModels } from "@/lib/model-rates";
import type { UpstreamDoc, UpstreamModelMeta, UpstreamModelPrice } from "@/lib/types";
import { BaseModelPicker } from "@/components/admin/base-model-picker";

type UpstreamApiFormatValue = "auto" | "chat" | "responses" | "messages" | "interactions";

interface UpstreamFormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: UpstreamApiFormatValue;
  priority: string;
  enabled: string;
  /** 上游整体倍率（providerRate）草稿；空串 = 1。 */
  multiplier: string;
}

const API_FORMAT_LABELS: Record<UpstreamApiFormatValue, string> = {
  auto: "跟随客户端",
  chat: "Chat Completions",
  responses: "Responses",
  messages: "Messages",
  interactions: "Interactions",
};

const emptyUpstreamForm: UpstreamFormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  apiFormat: "auto",
  priority: "0",
  enabled: "1",
  multiplier: "",
};

/** pi-catalog 归一化倍率（upstreams.modelPrices 缺失时的兜底）。 */
type CatalogMeta = Record<string, UpstreamModelMeta>;
/** 上游 `/v1/models` 自报的报价（倍率口径），探测时刷新、保存时原样带回。 */
type PriceMap = Record<string, UpstreamModelPrice>;
/** 草稿只记录用户动过的字段；未触碰字段缺省，由生效值解析兜底。 */
interface MetaDraft {
  /** 空串 = 恢复自动匹配，undefined = 未修改。 */
  catalogModelId?: string;
  inputRate?: string;
  cacheReadRate?: string;
  cacheWriteRate?: string;
  outputRate?: string;
  /** 模型整体倍率（modelRate）草稿；空串 = 1。 */
  multiplier?: string;
  /** 长上下文阶梯草稿（整份覆盖）；undefined = 未动，沿用上游/目录。 */
  tiers?: TierDraft[];
  /** 峰谷草稿（整份覆盖）；undefined = 未动，沿用上游/目录。 */
  timeBased?: ScheduleDraft;
}

/** 长上下文阶梯的行编辑状态（全部以字符串保存，提交时统一校验）。 */
interface TierDraft {
  inputThreshold: string;
  inputRate: string;
  cacheReadRate: string;
  cacheWriteRate: string;
  outputRate: string;
}

/** 峰谷配置的行编辑状态：谷时系数 + 每行一个时段。 */
interface ScheduleDraft {
  offPeakMultiplier: string;
  peakWindows: string;
}

interface BulkEditValues {
  changeMultiplier: boolean;
  multiplier: string;
  changeOffPeak: boolean;
  offPeakMultiplier: string;
  changeWindows: boolean;
  peakWindows: string;
}

/** 先校验整批再生成草稿，未勾选的字段逐模型保留。 */
function buildBulkEditDrafts(
  modelIds: readonly string[],
  values: BulkEditValues,
  scheduleOf: (modelId: string) => ScheduleDraft,
): Record<string, Partial<MetaDraft>> {
  if (!values.changeMultiplier && !values.changeOffPeak && !values.changeWindows) {
    throw new Error("请至少选择一个要修改的字段。");
  }
  if (values.changeMultiplier && parseMultiplierInput(values.multiplier) === "invalid") {
    throw new Error("模型整体倍率必须是非负数字。");
  }
  if (values.changeOffPeak && parseMultiplierInput(values.offPeakMultiplier) === "invalid") {
    throw new Error("谷时倍率必须是非负数字。");
  }
  const patches: Record<string, Partial<MetaDraft>> = {};
  for (const modelId of modelIds) {
    const patch: Partial<MetaDraft> = {};
    if (values.changeMultiplier) patch.multiplier = values.multiplier;
    if (values.changeOffPeak || values.changeWindows) {
      const schedule = { ...scheduleOf(modelId) };
      if (values.changeOffPeak) schedule.offPeakMultiplier = values.offPeakMultiplier;
      if (values.changeWindows) schedule.peakWindows = values.peakWindows;
      const parsed = parsePeakWindows(schedule.peakWindows);
      if ("error" in parsed) throw new Error(`模型 ${modelId}：${parsed.error}`);
      if (values.changeOffPeak && parsed.windows.length === 0) {
        throw new Error(`模型 ${modelId} 没有峰值时段，请同时设置峰值时段后再修改谷时倍率。`);
      }
      patch.timeBased = schedule;
    }
    patches[modelId] = patch;
  }
  return patches;
}

function omitModels<T>(values: Record<string, T>, modelIds: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([id]) => !modelIds.has(id)));
}

function BulkModelEditor({ modelIds, onApply, onClose }: {
  modelIds: string[];
  onApply: (values: BulkEditValues) => string | undefined;
  onClose: () => void;
}) {
  const [values, setValues] = useState<BulkEditValues>({
    changeMultiplier: false, multiplier: "1", changeOffPeak: false,
    offPeakMultiplier: "1", changeWindows: false, peakWindows: "",
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100vh-6rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量编辑 {modelIds.length} 个模型</DialogTitle>
          <DialogDescription>勾选要修改的字段，未勾选的保留各模型原值。应用后需保存上游。</DialogDescription>
        </DialogHeader>
        <form id="bulk-model-form" className="grid gap-4" onSubmit={(event) => {
          event.preventDefault();
          setError(onApply(values) ?? null);
        }}>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Checkbox checked={values.changeMultiplier} onCheckedChange={(checked) => setValues({ ...values, changeMultiplier: checked === true })} />
              设置模型整体倍率
            </Label>
            <Input aria-label="批量模型整体倍率" inputMode="decimal" disabled={!values.changeMultiplier}
              value={values.multiplier} onChange={(event) => setValues({ ...values, multiplier: event.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Checkbox checked={values.changeOffPeak} onCheckedChange={(checked) => setValues({ ...values, changeOffPeak: checked === true })} />
              设置谷时倍率（峰时 = 1）
            </Label>
            <Input aria-label="批量谷时倍率" inputMode="decimal" disabled={!values.changeOffPeak}
              value={values.offPeakMultiplier} onChange={(event) => setValues({ ...values, offPeakMultiplier: event.target.value })} />
            <p className="text-xs text-muted-foreground">仅修改谷时倍率时保留各模型峰值时段；没有时段的模型需要同时设置时段。</p>
          </div>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Checkbox checked={values.changeWindows} onCheckedChange={(checked) => setValues({ ...values, changeWindows: checked === true })} />
              设置峰值时段
            </Label>
            <Textarea aria-label="批量峰值时段" rows={4} disabled={!values.changeWindows}
              className="font-mono text-xs" placeholder={"1-5 01:00-09:00\n0,6 12:00-14:00"}
              value={values.peakWindows} onChange={(event) => setValues({ ...values, peakWindows: event.target.value })} />
            <p className="text-xs text-muted-foreground">UTC，每行一个时段，星期 0 = 周日。留空清除自定义峰谷配置并恢复继承。</p>
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="submit" form="bulk-model-form">应用到所选模型</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function emptyTierDraft(): TierDraft {
  return { inputThreshold: "", inputRate: "", cacheReadRate: "", cacheWriteRate: "", outputRate: "" };
}

/** 与服务端一致的四位小数量化，避免浮点尾巴污染展示。 */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 倍率编辑：非负数字，空串 = 0（不计费）。 */
function parseRateInput(input: string): number | "invalid" {
  const trimmed = input.trim();
  if (!trimmed) {
    return 0;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/** 整体倍率编辑：非负数字，空串 = 1（不缩放）；0 = 免费。 */
function parseMultiplierInput(input: string): number | "invalid" {
  const trimmed = input.trim();
  if (!trimmed) {
    return 1;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/** 整体倍率展示值：缺省/非法 = 1。 */
function multiplierDisplay(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? String(value) : "1";
}

/**
 * 整体倍率解析（提交路径用，输入已在前面校验过）：空串/非法 = 1，
 * 其余为非负数字。
 */
function parseMultiplier(input: string): number {
  const parsed = parseMultiplierInput(input);
  return parsed === "invalid" ? 1 : parsed;
}

/** 草稿阶梯 → 提交形状：只保留填了阈值的行，空字段表示「沿用基础档」。 */
function draftTiersToMeta(tiers: TierDraft[]): UpstreamModelMeta["tiers"] {
  const parsed: NonNullable<UpstreamModelMeta["tiers"]> = [];
  for (const tier of tiers) {
    const threshold = Number(tier.inputThreshold.trim());
    if (!Number.isFinite(threshold) || threshold <= 0) {
      continue;
    }
    const entry: NonNullable<UpstreamModelMeta["tiers"]>[number] = { inputThreshold: threshold };
    const optional = (value: string): number | undefined => {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const parsedValue = Number(trimmed);
      return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : undefined;
    };
    const inputRate = optional(tier.inputRate);
    const cacheReadRate = optional(tier.cacheReadRate);
    const cacheWriteRate = optional(tier.cacheWriteRate);
    const outputRate = optional(tier.outputRate);
    if (inputRate !== undefined) entry.inputRate = inputRate;
    if (cacheReadRate !== undefined) entry.cacheReadRate = cacheReadRate;
    if (cacheWriteRate !== undefined) entry.cacheWriteRate = cacheWriteRate;
    if (outputRate !== undefined) entry.outputRate = outputRate;
    parsed.push(entry);
  }
  return parsed.sort((a, b) => a.inputThreshold - b.inputThreshold);
}

/** 已存阶梯 → 草稿行（编辑表单回显）。 */
function metaTiersToDraft(tiers: UpstreamModelMeta["tiers"] | undefined): TierDraft[] {
  return (tiers ?? []).map((tier) => ({
    inputThreshold: String(tier.inputThreshold),
    inputRate: tier.inputRate !== undefined && tier.inputRate !== null ? String(tier.inputRate) : "",
    cacheReadRate: tier.cacheReadRate !== undefined && tier.cacheReadRate !== null ? String(tier.cacheReadRate) : "",
    cacheWriteRate: tier.cacheWriteRate !== undefined && tier.cacheWriteRate !== null ? String(tier.cacheWriteRate) : "",
    outputRate: tier.outputRate !== undefined && tier.outputRate !== null ? String(tier.outputRate) : "",
  }));
}

/** 草稿峰谷 → 提交形状：无合法时段即返回 undefined（视为未配置）。 */
function draftScheduleToMeta(draft: ScheduleDraft): UpstreamModelMeta["timeBased"] {
  const parsed = parsePeakWindows(draft.peakWindows);
  if ("error" in parsed || parsed.windows.length === 0) {
    return undefined;
  }
  const multiplier = Number(draft.offPeakMultiplier.trim() || "1");
  return {
    offPeakMultiplier: Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : 1,
    peakWindows: parsed.windows,
  };
}

/** 已存峰谷 → 草稿（编辑表单回显）。 */
function metaScheduleToDraft(schedule: UpstreamModelMeta["timeBased"] | undefined): ScheduleDraft {
  return {
    offPeakMultiplier: schedule ? String(schedule.offPeakMultiplier) : "1",
    peakWindows: schedule ? formatPeakWindows(schedule) : "",
  };
}

/**
 * 单模型编辑面板：覆盖开关、四腿倍率、模型整体倍率，以及长上下文阶梯
 * （整份覆盖）与峰谷配置（谷时系数 + 时段）。
 *
 * 所有值都以字符串保存草稿，由上级在保存时统一校验；空阶梯表 = 不启用
 * 自定义阶梯（沿用上游报价 / pi-catalog），时段清空 = 不启用周期性谷时价，
 * 覆盖关闭时倍率输入框禁用并回显基础倍率。
 */
function ModelEditor({
  modelId,
  catalogModelId,
  catalog,
  open,
  override,
  rates,
  multiplier,
  tiers,
  schedule,
  inheritedTiers,
  inheritedSchedule,
  inheritedRates,
  onChange,
  onOverrideChange,
  onClose,
}: {
  modelId: string;
  catalogModelId: string;
  catalog: CatalogMeta;
  open: boolean;
  override: boolean;
  rates: { inputRate: string; cacheReadRate: string; cacheWriteRate: string; outputRate: string };
  multiplier: string;
  tiers: TierDraft[];
  schedule: ScheduleDraft;
  inheritedTiers: UpstreamModelMeta["tiers"];
  inheritedSchedule: UpstreamModelMeta["timeBased"];
  /** 未覆盖时表格里展示的基础倍率（只读提示）。 */
  inheritedRates: { inputRate: number; cacheReadRate: number; cacheWriteRate: number; outputRate: number };
  onChange: (patch: Partial<MetaDraft>) => void;
  onOverrideChange: (override: boolean) => void;
  onClose: () => void;
}) {
  const [choosingCatalog, setChoosingCatalog] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogLimit, setCatalogLimit] = useState(50);
  const catalogResults = useMemo(
    () => choosingCatalog ? rankCatalogModels(modelId, Object.keys(catalog), catalogSearch) : [],
    [choosingCatalog, modelId, catalog, catalogSearch],
  );
  const setTier = (index: number, patch: Partial<TierDraft>) =>
    onChange({ tiers: tiers.map((tier, position) => (position === index ? { ...tier, ...patch } : tier)) });
  const inheritedTierText = (inheritedTiers ?? [])
    .map((tier) => `>${tier.inputThreshold} tokens`)
    .join("、");
  const setRate = (field: keyof typeof rates, value: string) => onChange({ [field]: value });
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100vh-6rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="font-mono text-base">{modelId}</DialogTitle>
          <DialogDescription>
            四腿倍率（输入 / 缓存读取 / 缓存写入 / 输出）留空 = 沿用基础倍率；覆盖关闭时直接使用上游
            `/v1/models` 报价或 pi-catalog，开启后以下自定义值生效。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid min-w-0 gap-2 rounded-lg border p-3">
            <Label htmlFor="catalog-model-target" className="text-xs">pi-catalog 目标模型</Label>
            <Popover
              modal
              open={choosingCatalog}
              onOpenChange={(next) => {
                setChoosingCatalog(next);
                if (next) {
                  setCatalogSearch("");
                  setCatalogLimit(50);
                }
              }}
            >
              <PopoverTrigger asChild>
                <Button
                  id="catalog-model-target"
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={choosingCatalog}
                  className="w-full min-w-0 justify-between font-mono text-xs"
                >
                  <span className="truncate">{catalogModelId || "自动匹配"}</span>
                  <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
                <Command shouldFilter={false}>
                  <CommandInput
                    aria-label="搜索 pi-catalog 模型"
                    placeholder="搜索模型 ID 或供应商…"
                    value={catalogSearch}
                    onValueChange={(value) => {
                      setCatalogSearch(value);
                      setCatalogLimit(50);
                    }}
                  />
                  <CommandList className="max-h-64">
                    <CommandGroup>
                      <CommandItem
                        value="__auto__"
                        data-checked={!catalogModelId}
                        onSelect={() => {
                          onChange({ catalogModelId: "" });
                          setChoosingCatalog(false);
                        }}
                      >
                        自动匹配（恢复默认）
                      </CommandItem>
                    </CommandGroup>
                    <CommandGroup heading={`${catalogResults.length} 个结果 · 按匹配度排序`}>
                      {catalogResults.slice(0, catalogLimit).map((id) => (
                        <CommandItem
                          key={id}
                          value={id}
                          data-checked={id === catalogModelId}
                          className="font-mono text-xs"
                          onSelect={() => {
                            onChange({ catalogModelId: id });
                            setChoosingCatalog(false);
                          }}
                        >
                          <span className="min-w-0 break-all">{id}</span>
                        </CommandItem>
                      ))}
                      {catalogResults.length > catalogLimit ? (
                        <CommandItem value="__more__" onSelect={() => setCatalogLimit((limit) => limit + 50)}>
                          显示更多
                        </CommandItem>
                      ) : null}
                    </CommandGroup>
                    {catalogResults.length === 0 ? (
                      <p className="p-3 text-xs text-muted-foreground" role="status">
                        {Object.keys(catalog).length === 0 ? "目录尚未加载，请先更新元数据。" : "没有找到匹配的模型。"}
                      </p>
                    ) : null}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {catalogModelId && !Object.hasOwn(catalog, catalogModelId) ? (
              <p className="text-xs text-destructive">当前目录中未找到此目标，请更新元数据或重新选择。</p>
            ) : null}
            <p className="text-[10px] text-muted-foreground">
              用于默认倍率、长上下文阶梯和峰谷配置；自定义覆盖和上游报价仍优先。修改后需保存上游。
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div className="min-w-0">
              <Label htmlFor={`model-override-${modelId}`} className="text-xs">
                覆盖自定义倍率
              </Label>
              <p className="text-[10px] text-muted-foreground">
                {override
                  ? "按下方输入值计价（未填的腿沿用基础倍率）。"
                  : `当前按基础倍率计价：${inheritedRates.inputRate} / ${inheritedRates.cacheReadRate} / ${inheritedRates.cacheWriteRate} / ${inheritedRates.outputRate}`}
              </p>
            </div>
            <Switch
              id={`model-override-${modelId}`}
              checked={override}
              onCheckedChange={onOverrideChange}
              aria-label={`覆盖 ${modelId}`}
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["inputRate", "输入倍率"],
                ["cacheReadRate", "缓存读取倍率"],
                ["cacheWriteRate", "缓存写入倍率"],
                ["outputRate", "输出倍率"],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="grid gap-1">
                <Label htmlFor={`model-${field}-${modelId}`} className="text-[10px]">
                  {label}
                </Label>
                <Input
                  id={`model-${field}-${modelId}`}
                  inputMode="decimal"
                  disabled={!override}
                  className="h-8 font-mono text-xs tabular-nums"
                  placeholder={String(inheritedRates[field])}
                  value={rates[field]}
                  onChange={(event) => setRate(field, event.target.value)}
                />
              </div>
            ))}
          </div>

          <div className="grid gap-1 sm:w-40">
            <Label htmlFor={`model-multiplier-${modelId}`} className="text-[10px]">
              模型整体倍率（缺省 = 1）
            </Label>
            <Input
              id={`model-multiplier-${modelId}`}
              inputMode="decimal"
              className="h-8 font-mono text-xs tabular-nums"
              placeholder="1"
              value={multiplier}
              onChange={(event) => onChange({ multiplier: event.target.value })}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">长上下文阶梯</Label>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">
                  {inheritedTierText ? `当前继承：${inheritedTierText}` : "当前无阶梯"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onChange({ tiers: [...tiers, emptyTierDraft()] })}
                >
                  <Plus />
                  添加档位
                </Button>
              </div>
            </div>
            {tiers.length === 0 ? (
              <p className="text-[10px] text-muted-foreground">
                未自定义时沿用上游 /v1/models 或 pi-catalog 的阶梯配置；留空的倍率字段沿用基础档。
              </p>
            ) : (
              <div className="overflow-hidden rounded-lg border bg-background">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">阈值 (tokens)</TableHead>
                      <TableHead className="w-24">输入</TableHead>
                      <TableHead className="w-24">缓存读取</TableHead>
                      <TableHead className="w-24">缓存写入</TableHead>
                      <TableHead className="w-24">输出</TableHead>
                      <TableHead className="w-14">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tiers.map((tier, index) => (
                      <TableRow key={index}>
                        <TableCell>
                          <Input
                            inputMode="numeric"
                            className="h-8 font-mono text-xs tabular-nums"
                            placeholder="128000"
                            value={tier.inputThreshold}
                            onChange={(event) => setTier(index, { inputThreshold: event.target.value })}
                          />
                        </TableCell>
                        {(["inputRate", "cacheReadRate", "cacheWriteRate", "outputRate"] as const).map((field) => (
                          <TableCell key={field}>
                            <Input
                              inputMode="decimal"
                              className="h-8 font-mono text-xs tabular-nums"
                              placeholder="沿用"
                              value={tier[field]}
                              onChange={(event) => setTier(index, { [field]: event.target.value })}
                            />
                          </TableCell>
                        ))}
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => onChange({ tiers: tiers.filter((_, position) => position !== index) })}
                          >
                            删除
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">峰谷计费</Label>
              {inheritedSchedule ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => onChange({ timeBased: metaScheduleToDraft(undefined) })}
                >
                  重置为继承值
                </Button>
              ) : null}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {inheritedSchedule
                ? `当前继承：谷时 ×${inheritedSchedule.offPeakMultiplier}，时段 ${formatPeakWindows(inheritedSchedule) || "—"}`
                : "当前无峰谷配置；留空的时段 = 不启用周期性谷时价"}
            </p>
            <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
              <div className="grid gap-1">
                <Label htmlFor="model-off-peak" className="text-[10px]">
                  谷时系数（峰值 = 1）
                </Label>
                <Input
                  id="model-off-peak"
                  inputMode="decimal"
                  className="h-8 font-mono text-xs tabular-nums"
                  placeholder="1"
                  value={schedule.offPeakMultiplier}
                  onChange={(event) =>
                    onChange({
                      timeBased: { ...schedule, offPeakMultiplier: event.target.value },
                    })
                  }
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="model-peak-windows" className="text-[10px]">
                  峰值时段（UTC，每行一个；星期 0 = 周日）
                </Label>
                <textarea
                  id="model-peak-windows"
                  rows={3}
                  spellCheck={false}
                  placeholder={"1-5 01:00-09:00\n6-0 12:00-14:00"}
                  className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  value={schedule.peakWindows}
                  onChange={(event) => onChange({ timeBased: { ...schedule, peakWindows: event.target.value } })}
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UpstreamsManager({ upstreams }: { upstreams: UpstreamDoc[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<UpstreamFormState>(emptyUpstreamForm);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  /** 批量操作的勾选集合，与 models 的启用状态无关。 */
  const [checkedModels, setCheckedModels] = useState<string[]>([]);
  const [bulkEditingModels, setBulkEditingModels] = useState<string[]>([]);
  const [pendingDeleteModels, setPendingDeleteModels] = useState<string[]>([]);
  const [batchTestProgress, setBatchTestProgress] = useState<{ completed: number; total: number } | null>(null);
  const batchTestController = useRef<AbortController | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  /** 表中保留但停用的模型：不写入 models，仍在表格中显示，可随时重新启用。 */
  const [disabledModels, setDisabledModels] = useState<string[]>([]);
  const [manualModel, setManualModel] = useState("");
  const [fetchingModels, setFetchingModels] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [catalogMeta, setCatalogMeta] = useState<CatalogMeta>({});
  /** 当前表单上游的报价快照（探测回填 / 编辑时载入），保存时随 PUT 提交。 */
  const [modelPrices, setModelPrices] = useState<PriceMap>({});
  const [editingModelMeta, setEditingModelMeta] = useState<Record<string, UpstreamModelMeta>>({});
  const [metaDrafts, setMetaDrafts] = useState<Record<string, MetaDraft>>({});
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, boolean>>({});
  const [listTestingId, setListTestingId] = useState<string | null>(null);
  const [listTestResults, setListTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  /** 打开单模型编辑面板的模型；同时只编辑一个。 */
  const [editingModelId, setEditingModelId] = useState<string | null>(null);

  useEffect(() => () => batchTestController.current?.abort(), []);

  function setFormOpen(open: boolean) {
    if (!open) batchTestController.current?.abort();
    setShowForm(open);
  }

  // pi-catalog 元数据（归一化倍率），页面加载时拉取一次；上游 `/v1/models`
  // 自报的报价在各自编辑表单里优先于它。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/admin/models/metadata");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          metadata?: Record<string, UpstreamModelMeta>;
        };
        if (!cancelled && payload.metadata) {
          setCatalogMeta(payload.metadata);
        }
      } catch {
        // 元数据仅用于展示/默认值，拉取失败静默降级（倍率按 1x 展示）。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function startCreate() {
    setEditingId(null);
    setForm(emptyUpstreamForm);
    setSelectedModels([]);
    setCheckedModels([]);
    setBulkEditingModels([]);
    setPendingDeleteModels([]);
    setDiscoveredModels([]);
    setDisabledModels([]);
    setManualModel("");
    setEditingModelMeta({});
    setMetaDrafts({});
    setOverrideDrafts({});
    setModelPrices({});
    setTestResults({});
    setEditingModelId(null);
    setFormError(null);
    setShowForm(true);
    setError(null);
  }

  function startEdit(upstream: UpstreamDoc) {
    setEditingId(upstream._id);
    setForm({
      name: upstream.name,
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
      apiFormat: (upstream.apiFormat ?? "auto") as UpstreamApiFormatValue,
      priority: String(upstream.priority),
      enabled: upstream.enabled ? "1" : "0",
      multiplier: multiplierDisplay(upstream.multiplier),
    });
    setSelectedModels([...upstream.models].sort((a, b) => a.localeCompare(b)));
    setCheckedModels([]);
    setBulkEditingModels([]);
    setPendingDeleteModels([]);
    setDiscoveredModels([...upstream.models].sort((a, b) => a.localeCompare(b)));
    setDisabledModels([...(upstream.disabledModels ?? [])].sort((a, b) => a.localeCompare(b)));
    setManualModel("");
    setEditingModelMeta(upstream.modelMeta ?? {});
    setMetaDrafts({});
    setOverrideDrafts({});
    setModelPrices(upstream.modelPrices ?? {});
    setTestResults({});
    setEditingModelId(null);
    setFormError(null);
    setShowForm(true);
    setError(null);
  }

  /** 停用模型：移出 models 并记入 disabledModels；仍留在表格中，可随时重新启用。 */
  function disableFormModel(modelId: string) {
    setSelectedModels((selected) => selected.filter((value) => value !== modelId));
    setDisabledModels((disabled) =>
      disabled.includes(modelId) ? disabled : [...disabled, modelId].sort((a, b) => a.localeCompare(b)),
    );
  }

  /** 启用模型：从停用列表移回 models（表格的「启用/停用」按钮）。 */
  function enableFormModel(modelId: string) {
    setDisabledModels((disabled) => disabled.filter((value) => value !== modelId));
    setSelectedModels((selected) =>
      selected.includes(modelId) ? selected : [...selected, modelId].sort((a, b) => a.localeCompare(b)),
    );
  }

  /** 从表中彻底删除模型：同时移除 models、停用列表、已存元数据与上游报价。 */
  function deleteFormModel(modelId: string) {
    setPendingDeleteModels([modelId]);
  }

  function removeFormModels(ids: readonly string[]) {
    const removed = new Set(ids);
    const keep = (values: string[]) => values.filter((id) => !removed.has(id));
    setSelectedModels(keep);
    setDiscoveredModels(keep);
    setDisabledModels(keep);
    setCheckedModels(keep);
    setModelPrices((values) => omitModels(values, removed));
    setEditingModelMeta((values) => omitModels(values, removed));
    setOverrideDrafts((values) => omitModels(values, removed));
    setMetaDrafts((values) => omitModels(values, removed));
    setTestResults((values) => omitModels(values, removed));
    setEditingModelId((current) => current && removed.has(current) ? null : current);
    setFormError(null);
  }

  function disableCheckedModels() {
    const checked = new Set(checkedModels);
    setSelectedModels((models) => models.filter((id) => !checked.has(id)));
    setDisabledModels((models) => [...new Set([...models, ...checked])]);
    toast.success(`已停用 ${checked.size} 个模型，保存上游后生效。`);
  }

  function applyBulkEdit(values: BulkEditValues): string | undefined {
    try {
      const patches = buildBulkEditDrafts(bulkEditingModels, values, (id) => pricingDraft(id).timeBased);
      setMetaDrafts((drafts) => {
        const next = { ...drafts };
        for (const [id, patch] of Object.entries(patches)) {
          next[id] = { ...next[id], ...patch };
        }
        return next;
      });
      setBulkEditingModels([]);
      toast.success(`已更新 ${bulkEditingModels.length} 个模型，保存上游后生效。`);
    } catch (error) {
      return error instanceof Error ? error.message : "批量编辑失败。";
    }
  }

  /** 手动添加模型：直接启用（表格里用「停用」撤销）。 */
  function addManualModel() {
    if (modelActionsBusy) return;
    const modelId = manualModel.trim();
    if (!modelId) return;
    setDiscoveredModels((models) =>
      models.includes(modelId) ? models : [...models, modelId].sort((a, b) => a.localeCompare(b)),
    );
    setSelectedModels((selected) =>
      selected.includes(modelId) ? selected : [...selected, modelId].sort((a, b) => a.localeCompare(b)),
    );
    setManualModel("");
  }

  async function fetchFormModels() {
    if (!form.baseUrl) {
      setFormError("请先填写 Base URL。");
      return;
    }
    setFetchingModels(true);
    setFormError(null);
    try {
      const response = await fetch("/api/admin/upstreams/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          apiFormat: form.apiFormat,
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        models?: string[];
        prices?: PriceMap;
        error?: string;
      } | null;
      if (!response.ok || !payload?.models) {
        setFormError(payload?.error ?? "拉取失败，请稍后重试。");
        return;
      }
      setDiscoveredModels((models) =>
        [...new Set([...models, ...payload.models ?? []])].sort((a, b) => a.localeCompare(b)),
      );
      // 新发现的模型默认启用；批量勾选与启用状态分开维护。
      setSelectedModels((selected) =>
        [...new Set([...selected, ...payload.models ?? []])].sort((a, b) => a.localeCompare(b)),
      );
      const prices = payload.prices ?? {};
      if (Object.keys(prices).length > 0) {
        setModelPrices((current) => ({ ...current, ...prices }));
        toast.success(
          `发现 ${payload.models.length} 个模型（已启用），其中 ${Object.keys(prices).length} 个带上游报价`,
        );
      } else {
        toast.success(`发现 ${payload.models.length} 个模型（已启用）`);
      }
    } catch {
      setFormError("网络错误，请稍后重试。");
    } finally {
      setFetchingModels(false);
    }
  }

  /** 从 pi-catalog 更新元数据：强制刷新服务端 24h 缓存并更新本页显示，
   *  不改变任何模型的覆盖开关与上游自报报价。 */
  async function updateMetaFromCatalog() {
    setFormError(null);
    try {
      const response = await fetch("/api/admin/models/metadata?refresh=1");
      if (!response.ok) {
        setFormError("元数据拉取失败，请稍后重试。");
        return;
      }
      const payload = (await response.json()) as {
        metadata?: Record<string, UpstreamModelMeta>;
      };
      const metadata = payload.metadata ?? {};
      if (Object.keys(metadata).length === 0) {
        toast.error("pi-catalog 无可用元数据（服务器可能无法访问 pi.dev）");
        return;
      }
      setCatalogMeta((meta) => ({ ...meta, ...metadata }));
      toast.success(`已从 pi-catalog 更新 ${Object.keys(metadata).length} 个模型的元数据`);
    } catch {
      setFormError("网络错误，请稍后重试。");
    }
  }

  function metaDraftOf(modelId: string): MetaDraft {
    return metaDrafts[modelId] ?? {};
  }

  /**
   * 附加计价的编辑草稿：动过就显示草稿，否则把「已存自定义 → 上游/目录」
   * 的生效配置铺进编辑器，避免打开时看到空表。
   */
  /**
   * 单模型编辑面板的倍率草稿：只回显「已存自定义 / 本次草稿」的值；留空表示
   * 沿用基础倍率（输入框占位符显示基础值）。覆盖关闭时不回显任何值 ——
   * 那时这些输入框本来就被禁用。
   */
  function rateDraftOf(modelId: string): {
    inputRate: string;
    cacheReadRate: string;
    cacheWriteRate: string;
    outputRate: string;
  } {
    const draft = metaDrafts[modelId];
    const stored = editingModelMeta[modelId];
    const pick = (draftValue: string | undefined, storedValue: number | null | undefined): string =>
      draftValue ?? (storedValue !== undefined && storedValue !== null ? String(storedValue) : "");
    return {
      inputRate: pick(draft?.inputRate, stored?.inputRate),
      cacheReadRate: pick(draft?.cacheReadRate, stored?.cacheReadRate),
      cacheWriteRate: pick(draft?.cacheWriteRate, stored?.cacheWriteRate),
      outputRate: pick(draft?.outputRate, stored?.outputRate),
    };
  }

  function pricingDraft(modelId: string): { tiers: TierDraft[]; timeBased: ScheduleDraft } {
    const draft = metaDrafts[modelId];
    const stored = editingModelMeta[modelId];
    const fallback = defaultMeta(modelId);
    const tiers = draft?.tiers
      ?? metaTiersToDraft(stored?.tiers ?? fallback.tiers);
    const schedule = draft?.timeBased
      ?? metaScheduleToDraft(stored?.timeBased ?? fallback.timeBased);
    return { tiers, timeBased: schedule };
  }

  /** 按模型覆盖开关：行草稿 > 已存自定义 > 默认关闭（用上游报价 → pi-catalog）。 */
  function rowOverride(modelId: string): boolean {
    return overrideDrafts[modelId] ?? editingModelMeta[modelId]?.override ?? false;
  }

  /** 打开覆盖时重置倍率草稿，保留独立的目录目标选择。 */
  function setRowOverride(modelId: string, override: boolean) {
    setOverrideDrafts((drafts) => ({ ...drafts, [modelId]: override }));
    if (override) {
      setMetaDrafts((drafts) => {
        if (drafts[modelId] === undefined) {
          return drafts;
        }
        const next = { ...drafts };
        const { catalogModelId, multiplier, tiers, timeBased } = drafts[modelId];
        next[modelId] = { catalogModelId, multiplier, tiers, timeBased };
        return next;
      });
    }
  }

  /** 模型整体倍率（modelRate）：行草稿 > 已存自定义 > 1（不缩放）。 */
  function rowMultiplier(modelId: string): string {
    const draft = metaDrafts[modelId]?.multiplier;
    if (draft !== undefined) {
      return draft;
    }
    return multiplierDisplay(editingModelMeta[modelId]?.multiplier);
  }

  function rowCatalogModelId(modelId: string): string {
    return metaDrafts[modelId]?.catalogModelId ?? editingModelMeta[modelId]?.catalogModelId ?? "";
  }

  /**
   * 单条腿的目录/报价来源：上游 `/v1/models` 报价优先，缺字段回退
   * pi-catalog，都没有按 1x。缓存腿缺省时按「输入价 × 折扣比例」折算
   * （上游自报两者时用上游的折扣，否则用目录的）—— 与服务端
   * `lib/model-rates.ts` 的解析口径一致。
   */
  function defaultMeta(modelId: string): {
    inputRate: number;
    cacheReadRate: number;
    cacheWriteRate: number;
    outputRate: number;
    cacheReadDiscount: number;
    cacheWriteDiscount: number;
    tiers?: UpstreamModelMeta["tiers"];
    timeBased?: UpstreamModelMeta["timeBased"];
  } {
    const price = modelPrices[modelId];
    const catalog = catalogModelDefault(modelId, catalogMeta, rowCatalogModelId(modelId));
    // 上游报价的 0 表示「未返回」（回退目录）；目录里的 0 是真实的「免费」。
    const returned = (value: number | null | undefined): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
    const catalogRate = (value: number | null | undefined): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
    const priceInput = returned(price?.inputRate);
    const priceRead = returned(price?.cacheReadRate);
    const priceWrite = returned(price?.cacheWriteRate);
    const catalogInput = returned(catalog?.inputRate);
    const catalogRead = catalogRate(catalog?.cacheReadRate);
    const catalogWrite = catalogRate(catalog?.cacheWriteRate);
    const ratio = (leg: number | undefined, input: number | undefined): number | undefined =>
      leg !== undefined && input !== undefined && input > 0 ? leg / input : undefined;
    const catalogReadDiscount = ratio(catalogRead, catalogInput) ?? 1;
    const catalogWriteDiscount = ratio(catalogWrite, catalogInput) ?? catalogReadDiscount;
    const cacheReadDiscount = ratio(priceRead, priceInput) ?? catalogReadDiscount;
    const cacheWriteDiscount = ratio(priceWrite, priceInput) ?? catalogWriteDiscount;
    const inputRate = priceInput ?? catalogInput ?? 1;
    return {
      inputRate,
      cacheReadRate: priceRead ?? catalogRead ?? round4(inputRate * catalogReadDiscount),
      cacheWriteRate: priceWrite ?? catalogWrite ?? round4(inputRate * catalogWriteDiscount),
      outputRate: returned(price?.outputRate) ?? returned(catalog?.outputRate) ?? 1,
      cacheReadDiscount,
      cacheWriteDiscount,
      // 结构整份取用：上游给了就用上游的，否则用目录的（自定义在 resolvedMeta 里优先）。
      tiers: price?.tiers ?? catalog?.tiers ?? undefined,
      timeBased: price?.timeBased ?? catalog?.timeBased ?? undefined,
    };
  }

  /** 该模型是否带上游 `/v1/models` 自报报价（表格里打标用）。 */
  function hasUpstreamPrice(modelId: string): boolean {
    const price = modelPrices[modelId];
    return price !== undefined
      && (price.inputRate !== undefined
        || price.cacheReadRate !== undefined
        || price.cacheWriteRate !== undefined
        || price.outputRate !== undefined
        || price.tiers !== undefined
        || price.timeBased !== undefined);
  }

  /** 生效元数据（按模型）：覆盖开启时 草稿 > 自定义 > 上游报价 > pi-catalog > 0
   *  （0 = 不计费）；关闭时直接用「上游报价 > pi-catalog」，缺失按 1x 展示。
   *  返回值为 tokenType 四腿（未含 modelRate / providerRate）。 */
  function resolvedMeta(modelId: string): {
    inputRate: number;
    cacheReadRate: number;
    cacheWriteRate: number;
    outputRate: number;
    tiers?: UpstreamModelMeta["tiers"];
    timeBased?: UpstreamModelMeta["timeBased"];
  } {
    const fallback = defaultMeta(modelId);
    const stored = editingModelMeta[modelId];
    const draft = metaDrafts[modelId];
    const extras = {
      tiers: draft?.tiers !== undefined
        ? draftTiersToMeta(draft.tiers) ?? fallback.tiers
        : stored?.tiers ?? fallback.tiers,
      timeBased: draft?.timeBased !== undefined
        ? draftScheduleToMeta(draft.timeBased) ?? fallback.timeBased
        : stored?.timeBased ?? fallback.timeBased,
    };
    if (!rowOverride(modelId)) {
      return { ...fallback, ...extras };
    }
    const pickRate = (
      draftValue: string | undefined,
      storedValue: number | null | undefined,
      defaultValue: number,
    ): number => {
      if (draftValue !== undefined) {
        const parsed = parseRateInput(draftValue);
        return parsed === "invalid" ? (storedValue ?? defaultValue) : parsed;
      }
      return storedValue ?? defaultValue;
    };
    const inputRate = pickRate(draft?.inputRate, stored?.inputRate, fallback.inputRate);
    return {
      inputRate,
      // 未填缓存价时按「实际输入价 × 折扣比例」折算（与 lib/model-rates.ts 一致），
      // 而不是直接沿用目录里的绝对缓存倍率 —— 两套口径不同。
      cacheReadRate: draft?.cacheReadRate !== undefined || stored?.cacheReadRate != null
        ? pickRate(draft?.cacheReadRate, stored?.cacheReadRate, fallback.cacheReadRate)
        : inputRate * fallback.cacheReadDiscount,
      cacheWriteRate: draft?.cacheWriteRate !== undefined || stored?.cacheWriteRate != null
        ? pickRate(draft?.cacheWriteRate, stored?.cacheWriteRate, fallback.cacheWriteRate)
        : inputRate * fallback.cacheWriteDiscount,
      outputRate: pickRate(draft?.outputRate, stored?.outputRate, fallback.outputRate),
      // 阶梯/峰谷：草稿（整份编辑）> 已存自定义 > 上游/目录。
      ...extras,
    };
  }

  /** 生效倍率（含 modelRate × providerRate），用于展示实际计费口径。 */
  function effectiveMeta(modelId: string): {
    inputRate: number;
    cacheReadRate: number;
    cacheWriteRate: number;
    outputRate: number;
  } {
    const base = resolvedMeta(modelId);
    const scale = parseMultiplier(rowMultiplier(modelId)) * parseMultiplier(form.multiplier);
    return {
      inputRate: base.inputRate * scale,
      cacheReadRate: base.cacheReadRate * scale,
      cacheWriteRate: base.cacheWriteRate * scale,
      outputRate: base.outputRate * scale,
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (modelActionsBusy) return;
    // 草稿格式校验：无效输入阻止提交。
    for (const [modelId, draft] of Object.entries(metaDrafts)) {
      const badRate =
        (draft.inputRate !== undefined && parseRateInput(draft.inputRate) === "invalid") ||
        (draft.cacheReadRate !== undefined && parseRateInput(draft.cacheReadRate) === "invalid") ||
        (draft.cacheWriteRate !== undefined && parseRateInput(draft.cacheWriteRate) === "invalid") ||
        (draft.outputRate !== undefined && parseRateInput(draft.outputRate) === "invalid");
      if (badRate) {
        setFormError(`模型 ${modelId} 的倍率必须是非负数字。`);
        return;
      }
      if (draft.multiplier !== undefined && parseMultiplierInput(draft.multiplier) === "invalid") {
        setFormError(`模型 ${modelId} 的整体倍率必须是非负数字。`);
        return;
      }
      // 阶梯：阈值必须是正整数，价格腿必须是非负数字（留空 = 沿用基础档）。
      if (draft.tiers) {
        for (const tier of draft.tiers) {
          if (!tier.inputThreshold.trim()) {
            continue;
          }
          const threshold = Number(tier.inputThreshold);
          if (!Number.isInteger(threshold) || threshold <= 0) {
            setFormError(`模型 ${modelId} 的长上下文阈值必须是正整数。`);
            return;
          }
          const badTierRate = [tier.inputRate, tier.cacheReadRate, tier.cacheWriteRate, tier.outputRate]
            .some((value) => value.trim() !== "" && parseRateInput(value) === "invalid");
          if (badTierRate) {
            setFormError(`模型 ${modelId} 的长上下文倍率必须是非负数字。`);
            return;
          }
        }
      }
      if (draft.timeBased) {
        const parsedWindows = parsePeakWindows(draft.timeBased.peakWindows);
        if ("error" in parsedWindows) {
          setFormError(`模型 ${modelId}：${parsedWindows.error}`);
          return;
        }
        const offPeak = Number(draft.timeBased.offPeakMultiplier.trim());
        if (draft.timeBased.offPeakMultiplier.trim() !== "" && (!Number.isFinite(offPeak) || offPeak < 0)) {
          setFormError(`模型 ${modelId} 的谷时系数必须是非负数字。`);
          return;
        }
      }
    }
    const providerMultiplier = parseMultiplierInput(form.multiplier);
    if (providerMultiplier === "invalid") {
      setFormError("上游整体倍率必须是非负数字。");
      return;
    }
    const modelMeta: Record<string, UpstreamModelMeta> = {};
    for (const modelId of tableModelIds) {
      const draft = metaDrafts[modelId];
      const hasDraft = draft !== undefined && Object.keys(draft).length > 0;
      if (overrideDrafts[modelId] === undefined && editingModelMeta[modelId] === undefined && !hasDraft) {
        continue;
      }
      const entry: UpstreamModelMeta = {
        override: rowOverride(modelId),
        ...(rowCatalogModelId(modelId) ? { catalogModelId: rowCatalogModelId(modelId) } : {}),
      };
      if (entry.override) {
        const resolved = resolvedMeta(modelId);
        entry.cacheReadRate = resolved.cacheReadRate;
        entry.cacheWriteRate = resolved.cacheWriteRate;
        entry.inputRate = resolved.inputRate;
        entry.outputRate = resolved.outputRate;
      }
      // 阶梯/峰谷是整份配置：只有用户真正编辑过（草稿里有）或本来就有自定义
      // 值时才写入。打开编辑器看一眼继承来的配置不该把它固化成自定义 ——
      // 否则上游/目录后续更新就再也影响不到这个模型。
      const tiers = draft?.tiers !== undefined ? draftTiersToMeta(draft.tiers) : editingModelMeta[modelId]?.tiers;
      if (tiers && tiers.length > 0) {
        entry.tiers = tiers;
      }
      const schedule = draft?.timeBased !== undefined
        ? draftScheduleToMeta(draft.timeBased)
        : editingModelMeta[modelId]?.timeBased;
      if (schedule) {
        entry.timeBased = schedule;
      }
      if (draft?.multiplier !== undefined) {
        entry.multiplier = parseMultiplier(draft.multiplier);
      } else if (editingModelMeta[modelId]?.multiplier !== undefined) {
        entry.multiplier = editingModelMeta[modelId]?.multiplier;
      }
      modelMeta[modelId] = entry;
    }
    const payload: Record<string, unknown> = {
      name: form.name,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
      apiFormat: form.apiFormat,
      models: selectedModels,
      disabledModels,
      multiplier: parseMultiplier(form.multiplier),
      priority: Number(form.priority) || 0,
      enabled: form.enabled === "1",
    };
    if (Object.keys(modelMeta).length > 0) {
      payload.modelMeta = modelMeta;
    }
    // 上游报价是服务端维护的数据：表单探测到就原样带回，否则省略该字段
    // 让服务端保留库中已有值（PUT 不会因此清空探测结果）。
    const keptPrices: PriceMap = {};
    for (const [modelId, price] of Object.entries(modelPrices)) {
      if (hasUpstreamPrice(modelId)) {
        keptPrices[modelId] = price;
      }
    }
    if (Object.keys(keptPrices).length > 0) {
      payload.modelPrices = keptPrices;
    } else if (editingId && Object.keys(upstreams.find((upstream) => upstream._id === editingId)?.modelPrices ?? {}).length > 0) {
      // 删除最后一个带报价的模型时，省略字段会让服务端保留已删除模型的旧报价。
      payload.modelPrices = null;
    }
    setBusy(true);
    setFormError(null);
    try {
      const response = await fetch(editingId ? `/api/admin/upstreams/${editingId}` : "/api/admin/upstreams", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? "保存失败，请稍后重试。");
        return;
      }
      setShowForm(false);
      router.refresh();
    } catch {
      setFormError("网络错误，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  async function removeUpstream(upstream: UpstreamDoc) {
    if (!window.confirm(`确定删除上游「${upstream.name}」？`)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/upstreams/${upstream._id}`, { method: "DELETE" });
      if (!response.ok) {
        setError("删除失败。");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  /** 上游列表的整体测试：自动挑该上游已配模型中倍率（输入 + 输出之和）最低者，
   *  用存储的凭据对该模型发一次最小 chat completion。 */
  async function overallTest(upstream: UpstreamDoc) {
    if (upstream.models.length === 0) {
      setError("该上游未配置模型。");
      return;
    }
    // 与服务端解析同一来源链：上游 /v1/models 报价 > pi-catalog > 1x。
    const rateOf = (modelId: string): { inputRate: number; cacheReadRate: number; outputRate: number } => {
      const price = upstream.modelPrices?.[modelId];
      const catalog = catalogModelDefault(modelId, catalogMeta, upstream.modelMeta?.[modelId]?.catalogModelId);
      const priceInput = price?.inputRate && price.inputRate > 0 ? price.inputRate : undefined;
      const priceCache = price?.cacheReadRate && price.cacheReadRate > 0 ? price.cacheReadRate : undefined;
      const priceOutput = price?.outputRate && price.outputRate > 0 ? price.outputRate : undefined;
      const catalogDiscount = catalog?.inputRate && catalog.inputRate > 0 && typeof catalog.cacheReadRate === "number" && catalog.cacheReadRate > 0
        ? catalog.cacheReadRate / catalog.inputRate
        : 1;
      const discount = priceInput !== undefined && priceCache !== undefined ? priceCache / priceInput : catalogDiscount;
      const fallbackInput = priceInput ?? (catalog?.inputRate && catalog.inputRate > 0 ? catalog.inputRate : 1);
      const fallbackOutput = priceOutput ?? (catalog?.outputRate && catalog.outputRate > 0 ? catalog.outputRate : 1);
      const fallbackCache =
        priceCache ?? (catalog?.cacheReadRate && catalog.cacheReadRate > 0 ? catalog.cacheReadRate : fallbackInput * discount);
      const meta = upstream.modelMeta?.[modelId];
      if (meta?.override) {
        const inputRate = meta.inputRate ?? fallbackInput;
        return {
          inputRate,
          cacheReadRate: meta.cacheReadRate ?? inputRate * discount,
          outputRate: meta.outputRate ?? fallbackOutput,
        };
      }
      return { inputRate: fallbackInput, cacheReadRate: fallbackCache, outputRate: fallbackOutput };
    };
    const cheapest = [...upstream.models].sort((a, b) => {
      const rateA = rateOf(a);
      const rateB = rateOf(b);
      const sumA = rateA.inputRate + rateA.cacheReadRate + rateA.outputRate;
      const sumB = rateB.inputRate + rateB.cacheReadRate + rateB.outputRate;
      return sumA !== sumB ? sumA - sumB : a.localeCompare(b);
    })[0];
    setListTestingId(upstream._id);
    setError(null);
    try {
      const response = await fetch("/api/admin/upstreams/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: upstream.baseUrl,
          apiKey: upstream.apiKey,
          model: cheapest,
          apiFormat: upstream.apiFormat ?? "auto",
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        latencyMs?: number;
        error?: string;
      } | null;
      if (!response.ok || typeof payload?.latencyMs !== "number") {
        setListTestResults((results) => ({
          ...results,
          [upstream._id]: { ok: false, text: payload?.error ?? "测试失败。" },
        }));
        return;
      }
      setListTestResults((results) => ({
        ...results,
        [upstream._id]: { ok: true, text: `${cheapest}（${payload.latencyMs} ms）` },
      }));
    } catch {
      setListTestResults((results) => ({ ...results, [upstream._id]: { ok: false, text: "网络错误。" } }));
    } finally {
      setListTestingId(null);
    }
  }

  /** 对单个模型发一次最小 chat completion，结果内联显示在该行测试按钮下。 */
  async function testModel(modelId: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    if (!form.baseUrl) {
      setFormError("请先填写 Base URL。");
      return { ok: false, text: "请先填写 Base URL。" };
    }
    setTestingModel(modelId);
    setFormError(null);
    try {
      const response = await fetch("/api/admin/upstreams/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          model: modelId,
          apiFormat: form.apiFormat,
        }),
        signal,
      });
      const payload = (await response.json().catch(() => null)) as {
        latencyMs?: number;
        error?: string;
      } | null;
      if (signal?.aborted) return { ok: false, text: "测试已停止。" };
      if (!response.ok || typeof payload?.latencyMs !== "number") {
        const failed = { ok: false, text: payload?.error ?? "测试失败。" };
        setTestResults((results) => ({ ...results, [modelId]: failed }));
        return failed;
      }
      const passed = { ok: true, text: `${payload.latencyMs} ms` };
      setTestResults((results) => ({ ...results, [modelId]: passed }));
      return passed;
    } catch {
      if (signal?.aborted) return { ok: false, text: "测试已停止。" };
      const failed = { ok: false, text: "网络错误。" };
      setTestResults((results) => ({ ...results, [modelId]: failed }));
      return failed;
    } finally {
      setTestingModel(null);
    }
  }

  async function testCheckedModels() {
    if (!form.baseUrl) {
      setFormError("请先填写 Base URL。");
      return;
    }
    const ids = [...checkedModels];
    const controller = new AbortController();
    batchTestController.current = controller;
    setBatchTestProgress({ completed: 0, total: ids.length });
    let completed = 0;
    let passed = 0;
    try {
      for (const id of ids) {
        if (controller.signal.aborted) break;
        const result = await testModel(id, controller.signal);
        if (controller.signal.aborted) break;
        completed += 1;
        if (result.ok) passed += 1;
        setBatchTestProgress({ completed, total: ids.length });
      }
      const summary = `${controller.signal.aborted ? "测试已停止" : "批量测试完成"}：${completed}/${ids.length}，成功 ${passed}，失败 ${completed - passed}`;
      if (completed > passed) toast.error(summary);
      else toast.success(summary);
    } finally {
      if (batchTestController.current === controller) {
        batchTestController.current = null;
        setBatchTestProgress(null);
      }
    }
  }

  /**
   * 表格行包含已发现、已启用和已停用的模型；固定按 ID 排序，让切换状态
   * 不移动或卸载当前聚焦的行，避免滚动视窗跳走。
   */
  const tableModelIds = [...new Set([...discoveredModels, ...selectedModels, ...disabledModels])];
  const sortedDiscovered = [...tableModelIds].sort((a, b) => a.localeCompare(b));
  const checkedSet = new Set(checkedModels);
  const checkedCount = tableModelIds.filter((id) => checkedSet.has(id)).length;
  const allChecked = tableModelIds.length > 0 && checkedCount === tableModelIds.length;
  const modelActionsBusy = busy || testingModel !== null || batchTestProgress !== null;
  return (
    <div className="grid gap-4">
      <div>
        <Button onClick={startCreate}>
          <Plus />
          新增上游
        </Button>
      </div>

      <BaseModelPicker />

      <Dialog open={showForm} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[calc(100vh-6rem)] overflow-y-auto sm:max-w-5xl">
          <DialogHeader className="pr-8">
            <DialogTitle>{editingId ? "编辑上游" : "新增上游"}</DialogTitle>
            <DialogDescription>
              填写模型服务的接口地址，例如{" "}
              <code className="font-mono text-xs">https://api.example.com/v1</code> 或{" "}
              <code className="font-mono text-xs">https://generativelanguage.googleapis.com/v1beta</code>
              ；协议决定请求与响应的格式（「跟随客户端」把调用方的请求与上游返回原样透传，不做协议转换）；
              优先级数字越小越优先，同一模型有多个来源时会自动按优先级切换。
            </DialogDescription>
          </DialogHeader>
          <form id="upstream-form" className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-2">
                <Label htmlFor="upstream-name">名称</Label>
                <Input
                  id="upstream-name"
                  required
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </div>
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="upstream-url">Base URL</Label>
                <Input
                  id="upstream-url"
                  required
                  type="url"
                  placeholder="https://api.example.com/v1"
                  value={form.baseUrl}
                  onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-key">API Key</Label>
                <Input
                  id="upstream-key"
                  value={form.apiKey}
                  onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-format">上游协议</Label>
                <Select
                  value={form.apiFormat}
                  onValueChange={(value) =>
                    setForm({ ...form, apiFormat: value as UpstreamApiFormatValue })
                  }
                >
                  <SelectTrigger id="upstream-format" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(API_FORMAT_LABELS) as UpstreamApiFormatValue[]).map((value) => (
                      <SelectItem key={value} value={value}>
                        {API_FORMAT_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-priority">优先级</Label>
                <Input
                  id="upstream-priority"
                  type="number"
                  min={0}
                  value={form.priority}
                  onChange={(event) => setForm({ ...form, priority: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-enabled">启用</Label>
                <Select value={form.enabled} onValueChange={(value) => setForm({ ...form, enabled: value })}>
                  <SelectTrigger id="upstream-enabled" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">启用</SelectItem>
                    <SelectItem value="0">停用</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-multiplier">上游整体倍率</Label>
                <Input
                  id="upstream-multiplier"
                  inputMode="decimal"
                  className="font-mono text-xs tabular-nums"
                  placeholder="1"
                  value={form.multiplier}
                  onChange={(event) => setForm({ ...form, multiplier: event.target.value })}
                />
                <p className="text-[10px] text-muted-foreground">
                  统一乘到该来源全部模型的生效价格上；留空 = 1，0 = 免费。
                </p>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={modelActionsBusy || fetchingModels || !form.baseUrl}
                  onClick={fetchFormModels}
                >
                  <RefreshCw className={fetchingModels ? "animate-spin" : undefined} />
                  {fetchingModels ? "拉取中…" : "从 /v1/models 拉取"}
                </Button>
                <div className="flex items-center gap-1.5">
                  <Input
                    placeholder="手动添加 model-id"
                    className="h-8 w-52 font-mono text-xs"
                    value={manualModel}
                    onChange={(event) => setManualModel(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addManualModel();
                      }
                    }}
                  />
                  <Button type="button" variant="outline" size="sm" onClick={addManualModel} disabled={modelActionsBusy || !manualModel.trim()}>
                    添加
                  </Button>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={updateMetaFromCatalog}>
                  <ArrowDownToLine />
                  从 pi-catalog 更新元数据
                </Button>
              </div>
            </div>

            <div className="grid gap-3">
              {tableModelIds.length > 0 ? (
                <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-popover p-2">
                  <span className="text-xs text-muted-foreground">已选 {checkedCount} / {tableModelIds.length}</span>
                  <Button type="button" variant="outline" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => void testCheckedModels()}>批量测试</Button>
                  <Button type="button" variant="outline" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={disableCheckedModels}>批量停用</Button>
                  <Button type="button" variant="outline" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => setBulkEditingModels([...checkedModels])}>批量编辑</Button>
                  <Button type="button" variant="destructive" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => setPendingDeleteModels([...checkedModels])}>批量删除</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => setCheckedModels([])}>取消选择</Button>
                  {batchTestProgress ? (
                    <>
                      <span className="text-xs tabular-nums" role="status">
                        已测试 {batchTestProgress.completed} / {batchTestProgress.total}
                      </span>
                      <Button type="button" variant="outline" size="sm" onClick={() => batchTestController.current?.abort()}>停止测试</Button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {tableModelIds.length > 0 ? (
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox aria-label="全选模型用于批量操作" disabled={modelActionsBusy}
                            checked={allChecked ? true : checkedCount > 0 ? "indeterminate" : false}
                            onCheckedChange={(checked) => setCheckedModels(checked === true ? [...tableModelIds] : [])} />
                        </TableHead>
                        <TableHead>模型 ID</TableHead>
                        <TableHead className="w-40">当前倍率</TableHead>
                        <TableHead className="w-56 text-right">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedDiscovered.map((modelId) => {
                        const rowDisabled = disabledModels.includes(modelId);
                        const enabled = selectedModels.includes(modelId);
                        const effective = effectiveMeta(modelId);
                        const meta = resolvedMeta(modelId);
                        const tiers = meta.tiers ?? [];
                        const hasExtras = tiers.length > 0 || meta.timeBased !== undefined;
                        return (
                          <TableRow key={modelId} data-state={checkedSet.has(modelId) ? "selected" : undefined}>
                            <TableCell>
                              <Checkbox aria-label={`选择模型 ${modelId}`} checked={checkedSet.has(modelId)} disabled={modelActionsBusy}
                                onCheckedChange={(checked) => setCheckedModels((models) => checked === true
                                  ? [...new Set([...models, modelId])]
                                  : models.filter((id) => id !== modelId))} />
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {modelId}
                              {rowDisabled ? (
                                <Badge variant="secondary" className="ml-2 font-sans text-[10px]">
                                  已停用
                                </Badge>
                              ) : null}
                              {hasUpstreamPrice(modelId) ? (
                                <Badge
                                  variant="outline"
                                  className="ml-2 font-sans text-[10px]"
                                  title="该上游的 /v1/models 自报了价格，解析时优先于 pi-catalog"
                                >
                                  上游报价
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="font-mono text-xs tabular-nums">
                              <span
                                title={`四腿顺序：输入 / 缓存读取 / 缓存写入 / 输出${
                                  hasExtras ? "（已含阶梯与峰谷配置）" : ""
                                }`}
                              >
                                {effective.inputRate} / {effective.cacheReadRate} / {effective.cacheWriteRate} /{" "}
                                {effective.outputRate}
                              </span>
                              {hasExtras ? (
                                <span className="ml-1 font-sans text-[10px] text-muted-foreground">
                                  {tiers.length > 0 ? `阶梯×${tiers.length}` : null}
                                  {tiers.length > 0 && meta.timeBased ? " · " : null}
                                  {meta.timeBased ? `峰谷×${meta.timeBased.offPeakMultiplier}` : null}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap items-center justify-end gap-1.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  disabled={modelActionsBusy}
                                  onClick={() => setEditingModelId(modelId)}
                                >
                                  编辑
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  disabled={modelActionsBusy}
                                  onClick={() => void testModel(modelId)}
                                >
                                  {testingModel === modelId ? "测试中…" : "测试"}
                                </Button>
                                {rowDisabled || !enabled ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    disabled={modelActionsBusy}
                                    onClick={() => enableFormModel(modelId)}
                                  >
                                    启用
                                  </Button>
                                ) : (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    disabled={modelActionsBusy}
                                    onClick={() => disableFormModel(modelId)}
                                  >
                                    停用
                                  </Button>
                                )}
                                <Button
                                  type="button"
                                  variant="destructive"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  disabled={modelActionsBusy}
                                  onClick={() => deleteFormModel(modelId)}
                                >
                                  删除
                                </Button>
                              </div>
                              {testResults[modelId] ? (
                                <p
                                  title={testResults[modelId].text}
                                  className={
                                    testResults[modelId].ok
                                      ? "mt-0.5 max-w-52 truncate text-right text-[10px] tabular-nums text-emerald-600"
                                      : "mt-0.5 max-w-52 truncate text-right text-[10px] text-destructive"
                                  }
                                >
                                  {testResults[modelId].text}
                                </p>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </div>


            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          </form>
          <DialogFooter>
            <Button type="submit" form="upstream-form" disabled={modelActionsBusy}>
              {editingId ? "保存" : "创建"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {editingModelId ? (
        <ModelEditor
          key={editingModelId}
          modelId={editingModelId}
          catalogModelId={rowCatalogModelId(editingModelId)}
          catalog={catalogMeta}
          open
          override={rowOverride(editingModelId)}
          rates={rateDraftOf(editingModelId)}
          multiplier={rowMultiplier(editingModelId)}
          tiers={pricingDraft(editingModelId).tiers}
          schedule={pricingDraft(editingModelId).timeBased}
          inheritedTiers={defaultMeta(editingModelId).tiers}
          inheritedSchedule={defaultMeta(editingModelId).timeBased}
          inheritedRates={defaultMeta(editingModelId)}
          onChange={(patch) =>
            setMetaDrafts((drafts) => ({
              ...drafts,
              [editingModelId]: { ...(drafts[editingModelId] ?? {}), ...patch },
            }))
          }
          onOverrideChange={(next) => setRowOverride(editingModelId, next)}
          onClose={() => setEditingModelId(null)}
        />
      ) : null}

      {bulkEditingModels.length > 0 ? (
        <BulkModelEditor modelIds={bulkEditingModels} onApply={applyBulkEdit} onClose={() => setBulkEditingModels([])} />
      ) : null}

      <AlertDialog open={pendingDeleteModels.length > 0} onOpenChange={(open) => { if (!open) setPendingDeleteModels([]); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {pendingDeleteModels.length} 个模型？</AlertDialogTitle>
            <AlertDialogDescription>
              将从此上游移除所选模型及其自定义配置、目录目标和上游报价，保存上游后生效。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              removeFormModels(pendingDeleteModels);
              setPendingDeleteModels([]);
            }}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">上游列表</CardTitle>
          <CardDescription>按优先级升序排列。</CardDescription>
        </CardHeader>
        <CardContent>
          {upstreams.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              还没有上游，点击「新增上游」添加第一个模型服务。
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>协议</TableHead>
                  <TableHead>优先级</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upstreams.map((upstream) => (
                  <TableRow key={upstream._id}>
                    <TableCell className="font-medium">{upstream.name}</TableCell>
                    <TableCell className="max-w-52 font-mono text-xs break-all">{upstream.baseUrl}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {API_FORMAT_LABELS[(upstream.apiFormat ?? "auto") as UpstreamApiFormatValue]}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{upstream.priority}</TableCell>
                    <TableCell className="tabular-nums">
                      {upstream.models.length === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        upstream.models.length
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={upstream.enabled ? "default" : "secondary"}>
                        {upstream.enabled ? "启用" : "停用"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => startEdit(upstream)}>
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={listTestingId === upstream._id}
                          onClick={() => overallTest(upstream)}
                        >
                          <Activity />
                          {listTestingId === upstream._id ? "测试中…" : "整体测试"}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => removeUpstream(upstream)}
                        >
                          删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {upstreams.map((upstream) =>
            listTestResults[upstream._id] ? (
              <div
                key={`test-${upstream._id}`}
                className="mt-4 grid gap-1 rounded-lg border bg-muted/40 p-4 first:mt-6"
              >
                <p className="text-sm font-medium">
                  「{upstream.name}」整体测试{listTestResults[upstream._id].ok ? "通过" : "失败"}
                </p>
                <p
                  className={
                    listTestResults[upstream._id].ok
                      ? "font-mono text-xs text-muted-foreground"
                      : "text-xs text-destructive"
                  }
                >
                  {listTestResults[upstream._id].text}
                </p>
              </div>
            ) : null,
          )}
        </CardContent>
      </Card>
    </div>
  );
}
