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

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, ArrowDownToLine, Plus, RefreshCw } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatPeakWindows, parsePeakWindows } from "@/lib/pricing";
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
  const multiplier = Number(draft.offPeakMultiplier.trim());
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
 * 附加计价编辑器：长上下文阶梯（整份覆盖）与峰谷配置（谷时系数 + 时段）。
 * 空的阶梯表 = 不启用自定义阶梯（沿用上游报价 / pi-catalog）；时段清空 =
 * 不启用周期性谷时价。两者都以字符串保存草稿，由上级统一校验。
 */
function PricingEditor({
  modelId,
  tiers,
  schedule,
  inheritedTiers,
  inheritedSchedule,
  onChange,
  onClose,
}: {
  modelId: string;
  tiers: TierDraft[];
  schedule: ScheduleDraft;
  inheritedTiers: UpstreamModelMeta["tiers"];
  inheritedSchedule: UpstreamModelMeta["timeBased"];
  onChange: (patch: Partial<MetaDraft>) => void;
  onClose: () => void;
}) {
  const setTier = (index: number, patch: Partial<TierDraft>) =>
    onChange({ tiers: tiers.map((tier, position) => (position === index ? { ...tier, ...patch } : tier)) });
  const inheritedTierText = (inheritedTiers ?? [])
    .map((tier) => `>${tier.inputThreshold} tokens`)
    .join("、");
  return (
    <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">附加计价 · {modelId}</p>
          <p className="text-[10px] text-muted-foreground">
            长上下文按提示总量整次切换档位；峰谷按 UTC 时段生效，峰值按牌价、其余时间乘谷时系数。
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          收起
        </Button>
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
        <Label className="text-xs">峰谷计费</Label>
        <p className="text-[10px] text-muted-foreground">
          {inheritedSchedule
            ? `当前继承：谷时 ×${inheritedSchedule.offPeakMultiplier}，时段 ${formatPeakWindows(inheritedSchedule) || "—"}`
            : "当前无峰谷配置"}
        </p>
        <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
          <div className="grid gap-1">
            <Label htmlFor="pricing-off-peak" className="text-[10px]">
              谷时系数（峰值 = 1）
            </Label>
            <Input
              id="pricing-off-peak"
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
            <Label htmlFor="pricing-peak-windows" className="text-[10px]">
              峰值时段（UTC，每行一个；星期 0 = 周日）
            </Label>
            <textarea
              id="pricing-peak-windows"
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
  );
}

export function UpstreamsManager({ upstreams }: { upstreams: UpstreamDoc[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<UpstreamFormState>(emptyUpstreamForm);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  /** 表中保留但停用的模型：不勾选、不保存进 models，仅在行内显示并可删除。 */
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
  /** 展开「附加计价」（长上下文阶梯 / 峰谷）的模型；同时只编辑一个。 */
  const [pricingEditorModel, setPricingEditorModel] = useState<string | null>(null);

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
    setDiscoveredModels([]);
    setDisabledModels([]);
    setManualModel("");
    setEditingModelMeta({});
    setMetaDrafts({});
    setOverrideDrafts({});
    setModelPrices({});
    setTestResults({});
    setPricingEditorModel(null);
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
    setDiscoveredModels([...upstream.models].sort((a, b) => a.localeCompare(b)));
    setDisabledModels([...(upstream.disabledModels ?? [])].sort((a, b) => a.localeCompare(b)));
    setManualModel("");
    setEditingModelMeta(upstream.modelMeta ?? {});
    setMetaDrafts({});
    setOverrideDrafts({});
    setModelPrices(upstream.modelPrices ?? {});
    setTestResults({});
    setPricingEditorModel(null);
    setFormError(null);
    setShowForm(true);
    setError(null);
  }

  function toggleFormModel(modelId: string) {
    if (disabledModels.includes(modelId)) {
      // 停用的模型不在候选集内，勾选即重新启用。
      setDisabledModels((disabled) => disabled.filter((value) => value !== modelId));
      return;
    }
    setSelectedModels((selected) =>
      selected.includes(modelId)
        ? selected.filter((value) => value !== modelId)
        : [...selected, modelId].sort((a, b) => a.localeCompare(b)),
    );
  }

  /** 停用模型：取消勾选并移出 models；仍留在表格中，可随时重新启用。 */
  function disableFormModel(modelId: string) {
    setSelectedModels((selected) => selected.filter((value) => value !== modelId));
    setDisabledModels((disabled) =>
      disabled.includes(modelId) ? disabled : [...disabled, modelId].sort((a, b) => a.localeCompare(b)),
    );
  }

  /** 从表中彻底删除模型：同时移除 models、停用列表、已存元数据与上游报价。 */
  function deleteFormModel(modelId: string) {
    if (!window.confirm(`确定从该上游删除模型「${modelId}」？`)) {
      return;
    }
    setSelectedModels((selected) => selected.filter((value) => value !== modelId));
    setDiscoveredModels((models) => models.filter((value) => value !== modelId));
    setDisabledModels((disabled) => disabled.filter((value) => value !== modelId));
    setModelPrices((prices) => {
      if (prices[modelId] === undefined) {
        return prices;
      }
      const next = { ...prices };
      delete next[modelId];
      return next;
    });
    setEditingModelMeta((meta) => {
      if (meta[modelId] === undefined) {
        return meta;
      }
      const next = { ...meta };
      delete next[modelId];
      return next;
    });
    setOverrideDrafts((drafts) => {
      if (drafts[modelId] === undefined) {
        return drafts;
      }
      const next = { ...drafts };
      delete next[modelId];
      return next;
    });
    setMetaDrafts((drafts) => {
      if (drafts[modelId] === undefined) {
        return drafts;
      }
      const next = { ...drafts };
      delete next[modelId];
      return next;
    });
    setTestResults((results) => {
      if (results[modelId] === undefined) {
        return results;
      }
      const next = { ...results };
      delete next[modelId];
      return next;
    });
    setFormError(null);
  }

  function addManualModel() {
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
      const prices = payload.prices ?? {};
      if (Object.keys(prices).length > 0) {
        setModelPrices((current) => ({ ...current, ...prices }));
        toast.success(
          `发现 ${payload.models.length} 个模型，其中 ${Object.keys(prices).length} 个带上游报价，勾选后保存即可`,
        );
      } else {
        toast.success(`发现 ${payload.models.length} 个模型，勾选后保存即可`);
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

  /** 打开「覆盖」时清掉该行草稿，输入框按当前生效值重新显示。 */
  function setRowOverride(modelId: string, override: boolean) {
    setOverrideDrafts((drafts) => ({ ...drafts, [modelId]: override }));
    if (override) {
      setMetaDrafts((drafts) => {
        if (drafts[modelId] === undefined) {
          return drafts;
        }
        const next = { ...drafts };
        delete next[modelId];
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
    const catalog = catalogMeta[modelId];
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
    if (!rowOverride(modelId)) {
      return fallback;
    }
    const stored = editingModelMeta[modelId];
    const draft = metaDrafts[modelId];
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
      tiers: draft?.tiers ? draftTiersToMeta(draft.tiers) : stored?.tiers ?? fallback.tiers,
      timeBased: draft?.timeBased ? draftScheduleToMeta(draft.timeBased) : stored?.timeBased ?? fallback.timeBased,
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
    for (const modelId of discoveredModels) {
      const draft = metaDrafts[modelId];
      const hasDraft = draft !== undefined && Object.keys(draft).length > 0;
      if (overrideDrafts[modelId] === undefined && editingModelMeta[modelId] === undefined && !hasDraft) {
        continue;
      }
      if (!rowOverride(modelId)) {
        // 覆盖关闭：只保留整体倍率草稿（若有），并关闭覆盖开关。
        const entry: UpstreamModelMeta = { override: false };
        if (draft?.multiplier !== undefined) {
          entry.multiplier = parseMultiplier(draft.multiplier);
        } else if (editingModelMeta[modelId]?.multiplier !== undefined) {
          entry.multiplier = editingModelMeta[modelId]?.multiplier;
        }
        modelMeta[modelId] = entry;
        continue;
      }
      const resolved = resolvedMeta(modelId);
      const entry: UpstreamModelMeta = {
        override: true,
        cacheReadRate: resolved.cacheReadRate,
        cacheWriteRate: resolved.cacheWriteRate,
        inputRate: resolved.inputRate,
        outputRate: resolved.outputRate,
      };
      // 阶梯/峰谷是整份配置：表单里编辑过就写入，否则沿用已存值（不写回
      // 「把上游/目录的结构固化成自定义」）。
      if (resolved.tiers && resolved.tiers.length > 0) {
        entry.tiers = resolved.tiers;
      }
      if (resolved.timeBased) {
        entry.timeBased = resolved.timeBased;
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
      const catalog = catalogMeta[modelId];
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
  async function testModel(modelId: string): Promise<{ ok: boolean; text: string }> {
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
      });
      const payload = (await response.json().catch(() => null)) as {
        latencyMs?: number;
        error?: string;
      } | null;
      if (!response.ok || typeof payload?.latencyMs !== "number") {
        const failed = { ok: false, text: payload?.error ?? "测试失败。" };
        setTestResults((results) => ({ ...results, [modelId]: failed }));
        return failed;
      }
      const passed = { ok: true, text: `${payload.latencyMs} ms` };
      setTestResults((results) => ({ ...results, [modelId]: passed }));
      return passed;
    } catch {
      const failed = { ok: false, text: "网络错误。" };
      setTestResults((results) => ({ ...results, [modelId]: failed }));
      return failed;
    } finally {
      setTestingModel(null);
    }
  }

  /** 表格行 = 发现的模型 ∪ 停用的模型；未选中的行沉底，停用行比未勾选行更靠下。 */
  const keptModelIds = new Set([...selectedModels, ...disabledModels]);
  const tableModelIds = [...new Set([...discoveredModels, ...disabledModels])];
  const sortedDiscovered = [...tableModelIds].sort((a, b) => {
    const keptFirst = Number(keptModelIds.has(a)) - Number(keptModelIds.has(b));
    if (keptFirst !== 0) {
      return keptFirst;
    }
    const disabledLast = Number(disabledModels.includes(a)) - Number(disabledModels.includes(b));
    return disabledLast !== 0 ? disabledLast : a.localeCompare(b);
  });
  const selectedDiscoveredCount = discoveredModels.filter((modelId) => selectedModels.includes(modelId)).length;
  const allDiscoveredSelected = discoveredModels.length > 0 && selectedDiscoveredCount === discoveredModels.length;
  const someDiscoveredSelected = selectedDiscoveredCount > 0 && !allDiscoveredSelected;

  function toggleAllDiscovered() {
    setSelectedModels(
      allDiscoveredSelected
        ? []
        : discoveredModels
            .filter((modelId) => !disabledModels.includes(modelId))
            .sort((a, b) => a.localeCompare(b)),
    );
  }

  /** 只读展示（覆盖关闭或未编辑时）的倍率文本。 */
  function rateDisplay(modelId: string, field: "inputRate" | "cacheReadRate" | "cacheWriteRate" | "outputRate"): string {
    return String(resolvedMeta(modelId)[field]);
  }

  return (
    <div className="grid gap-4">
      <div>
        <Button onClick={startCreate}>
          <Plus />
          新增上游
        </Button>
      </div>

      <BaseModelPicker />

      <Dialog open={showForm} onOpenChange={setShowForm}>
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
                  disabled={fetchingModels || !form.baseUrl}
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
                  <Button type="button" variant="outline" size="sm" onClick={addManualModel} disabled={!manualModel.trim()}>
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
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox
                            checked={
                              allDiscoveredSelected ? true : someDiscoveredSelected ? "indeterminate" : false
                            }
                            onCheckedChange={toggleAllDiscovered}
                            aria-label="全选/取消全选"
                          />
                        </TableHead>
                        <TableHead>模型 ID</TableHead>
                        <TableHead className="w-16">覆盖</TableHead>
                        <TableHead className="w-24">输入倍率</TableHead>
                        <TableHead className="w-24">缓存读取倍率</TableHead>
                        <TableHead className="w-24">缓存写入倍率</TableHead>
                        <TableHead className="w-24">输出倍率</TableHead>
                        <TableHead className="w-24">模型整体倍率</TableHead>
                        <TableHead className="w-28">实际倍率（生效）</TableHead>
                        <TableHead className="w-28">附加计价</TableHead>
                        <TableHead className="w-32">测试</TableHead>
                        <TableHead className="w-16">操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sortedDiscovered.map((modelId) => {
                        const meta = resolvedMeta(modelId);
                        const editable = rowOverride(modelId);
                        const rowDisabled = disabledModels.includes(modelId);
                        const rawDraft = metaDraftOf(modelId);
                        // 覆盖开启：未触碰字段显示当前生效值（自定义 > 上游报价 > pi-catalog > 0），
                        // 用户动过的字段（含主动清空 = 0）显示草稿原值。
                        const draft: MetaDraft = editable
                          ? {
                              inputRate: rawDraft.inputRate ?? String(meta.inputRate),
                              cacheReadRate: rawDraft.cacheReadRate ?? String(meta.cacheReadRate),
                              cacheWriteRate: rawDraft.cacheWriteRate ?? String(meta.cacheWriteRate),
                              outputRate: rawDraft.outputRate ?? String(meta.outputRate),
                            }
                          : rawDraft;
                        const setDraft = (field: keyof MetaDraft, value: string) =>
                          setMetaDrafts((drafts) => ({
                            ...drafts,
                            [modelId]: { ...metaDraftOf(modelId), [field]: value },
                          }));
                        return (
                          <TableRow
                            key={modelId}
                            className="cursor-pointer"
                            onClick={() => toggleFormModel(modelId)}
                          >
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              <Checkbox
                                checked={selectedModels.includes(modelId) || rowDisabled}
                                onCheckedChange={() => toggleFormModel(modelId)}
                              />
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {modelId}
                              {rowDisabled ? (
                                <Badge variant="secondary" className="ml-2 font-sans text-[10px]">
                                  已停用
                                </Badge>
                              ) : selectedModels.includes(modelId) ? (
                                <Badge variant="secondary" className="ml-2 font-sans text-[10px]">
                                  已选
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
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              <Switch
                                checked={rowOverride(modelId)}
                                onCheckedChange={(checked) => setRowOverride(modelId, checked)}
                                aria-label={"覆盖 " + modelId}
                              />
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {editable ? (
                                <Input
                                  inputMode="decimal"
                                  className="h-8 font-mono text-xs tabular-nums"
                                  value={draft.inputRate}
                                  onChange={(event) => setDraft("inputRate", event.target.value)}
                                />
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                  {rateDisplay(modelId, "inputRate")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {editable ? (
                                <Input
                                  inputMode="decimal"
                                  className="h-8 font-mono text-xs tabular-nums"
                                  value={draft.cacheReadRate}
                                  onChange={(event) => setDraft("cacheReadRate", event.target.value)}
                                />
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                  {rateDisplay(modelId, "cacheReadRate")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {editable ? (
                                <Input
                                  inputMode="decimal"
                                  className="h-8 font-mono text-xs tabular-nums"
                                  value={draft.cacheWriteRate}
                                  onChange={(event) => setDraft("cacheWriteRate", event.target.value)}
                                />
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                  {rateDisplay(modelId, "cacheWriteRate")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {editable ? (
                                <Input
                                  inputMode="decimal"
                                  className="h-8 font-mono text-xs tabular-nums"
                                  value={draft.outputRate}
                                  onChange={(event) => setDraft("outputRate", event.target.value)}
                                />
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                  {rateDisplay(modelId, "outputRate")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {editable ? (
                                <Input
                                  inputMode="decimal"
                                  className="h-8 font-mono text-xs tabular-nums"
                                  value={rowMultiplier(modelId)}
                                  onChange={(event) =>
                                    setMetaDrafts((drafts) => ({
                                      ...drafts,
                                      [modelId]: { ...metaDraftOf(modelId), multiplier: event.target.value },
                                    }))
                                  }
                                />
                              ) : (
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                                  {rowMultiplier(modelId)}
                                </span>
                              )}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {(() => {
                                const effective = effectiveMeta(modelId);
                                return (
                                  <span
                                    className="font-mono text-xs tabular-nums"
                                    title={`实际倍率 = 基础倍率 × ${rowMultiplier(modelId)} × ${multiplierDisplay(
                                      Number(form.multiplier) || 1,
                                    )}`}
                                  >
                                    {effective.inputRate} / {effective.cacheReadRate} / {effective.cacheWriteRate} /{" "}
                                    {effective.outputRate}
                                  </span>
                                );
                              })()}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              {(() => {
                                const tiers = meta.tiers ?? [];
                                const schedule = meta.timeBased;
                                if (tiers.length === 0 && !schedule) {
                                  return <span className="text-[10px] text-muted-foreground">—</span>;
                                }
                                return (
                                  <div className="grid gap-0.5 text-[10px] leading-tight">
                                    {tiers.length > 0 ? (
                                      <span
                                        className="font-mono tabular-nums"
                                        title={tiers
                                          .map((tier) => `>${tier.inputThreshold} tokens`)
                                          .join("\n")}
                                      >
                                        阶梯 {tiers.length} 档
                                      </span>
                                    ) : null}
                                    {schedule ? (
                                      <span
                                        className="font-mono tabular-nums"
                                        title={formatPeakWindows(schedule) || undefined}
                                      >
                                        峰谷 ×{schedule.offPeakMultiplier}
                                      </span>
                                    ) : null}
                                  </div>
                                );
                              })()}
                              {editable ? (
                                <Button
                                  type="button"
                                  variant="link"
                                  size="sm"
                                  className="h-5 px-0 text-[10px]"
                                  onClick={() => setPricingEditorModel(modelId)}
                                >
                                  编辑
                                </Button>
                              ) : null}
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              <div className="flex flex-col items-start gap-0.5">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  disabled={testingModel !== null}
                                  onClick={() => void testModel(modelId)}
                                >
                                  {testingModel === modelId ? "测试中…" : "测试"}
                                </Button>
                                {testResults[modelId] ? (
                                  <span
                                    title={testResults[modelId].text}
                                    className={
                                      testResults[modelId].ok
                                        ? "max-w-32 truncate text-[10px] tabular-nums text-emerald-600"
                                        : "max-w-32 truncate text-[10px] text-destructive"
                                    }
                                  >
                                    {testResults[modelId].text}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell onClick={(event) => event.stopPropagation()}>
                              <div className="flex flex-col items-start gap-1">
                                {rowDisabled ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    disabled={busy}
                                    onClick={() => toggleFormModel(modelId)}
                                  >
                                    启用
                                  </Button>
                                ) : (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    disabled={busy || !selectedModels.includes(modelId)}
                                    title={!selectedModels.includes(modelId) ? "仅可停用已启用的模型" : undefined}
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
                                  disabled={busy}
                                  onClick={() => deleteFormModel(modelId)}
                                >
                                  删除
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </div>

            {pricingEditorModel ? (
              <PricingEditor
                modelId={pricingEditorModel}
                tiers={pricingDraft(pricingEditorModel).tiers}
                schedule={pricingDraft(pricingEditorModel).timeBased}
                inheritedTiers={defaultMeta(pricingEditorModel).tiers}
                inheritedSchedule={defaultMeta(pricingEditorModel).timeBased}
                onChange={(patch) =>
                  setMetaDrafts((drafts) => ({
                    ...drafts,
                    [pricingEditorModel]: {
                      ...(drafts[pricingEditorModel] ?? {}),
                      ...patch,
                    },
                  }))
                }
                onClose={() => setPricingEditorModel(null)}
              />
            ) : null}

            {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
          </form>
          <DialogFooter>
            <Button type="submit" form="upstream-form" disabled={busy}>
              {editingId ? "保存" : "创建"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
