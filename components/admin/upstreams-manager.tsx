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

import { ModelEditor, type CatalogMeta, type CapabilityKey, type TierDraft, type ScheduleDraft, type MetaDraft, CAPABILITY_FIELDS, metaScheduleToDraft } from "@/components/models/model-editor";
import { useTranslator } from "@/components/i18n/locale-provider";
import type { Translator } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, ArrowDownToLine, Plus, RefreshCw } from "lucide-react";
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

import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";


import { parsePeakWindows } from "@/lib/pricing";
import { catalogModelDefault } from "@/lib/model-rates";
import type { UpstreamDoc, UpstreamModelMeta, UpstreamModelPrice } from "@/lib/types";
import type { CatalogMetadataMap } from "@/lib/pi-catalog";
import { resolveModelCapabilities, withModelDisplayNames } from "@/lib/model-capabilities";
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
/** 上游 `/v1/models` 自报的报价（倍率口径），探测时刷新、保存时原样带回。 */
type PriceMap = Record<string, UpstreamModelPrice>;
const rateDisplayFormat = new Intl.NumberFormat("en-US", {
  minimumSignificantDigits: 2,
  maximumSignificantDigits: 2,
  useGrouping: false,
});

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
  t: Translator,
): Record<string, Partial<MetaDraft>> {
  if (!values.changeMultiplier && !values.changeOffPeak && !values.changeWindows) {
    throw new Error(t("请至少选择一个要修改的字段。"));
  }
  if (values.changeMultiplier && parseMultiplierInput(values.multiplier) === "invalid") {
    throw new Error(t("模型整体倍率必须是非负数字。"));
  }
  if (values.changeOffPeak && parseMultiplierInput(values.offPeakMultiplier) === "invalid") {
    throw new Error(t("谷时倍率必须是非负数字。"));
  }
  const patches: Record<string, Partial<MetaDraft>> = {};
  for (const modelId of modelIds) {
    const patch: Partial<MetaDraft> = {};
    if (values.changeMultiplier) patch.multiplier = values.multiplier;
    if (values.changeOffPeak || values.changeWindows) {
      const schedule = { ...scheduleOf(modelId) };
      if (values.changeOffPeak) schedule.offPeakMultiplier = values.offPeakMultiplier;
      if (values.changeWindows) schedule.peakWindows = values.peakWindows;
      const parsed = parsePeakWindows(schedule.peakWindows, t);
      if ("error" in parsed) throw new Error(t("模型 {0}：{1}", { "0": modelId, "1": parsed.error }));
      if (values.changeOffPeak && parsed.windows.length === 0) {
        throw new Error(t("模型 {0} 没有峰值时段，请同时设置峰值时段后再修改谷时倍率。", { "0": modelId }));
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
  const t = useTranslator();
  const [values, setValues] = useState<BulkEditValues>({
    changeMultiplier: false, multiplier: "1", changeOffPeak: false,
    offPeakMultiplier: "1", changeWindows: false, peakWindows: "",
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[calc(100dvh-6rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("批量编辑")}{" "}{modelIds.length} {" "}{t("个模型")}</DialogTitle>
          <DialogDescription>{t("勾选要修改的字段，未勾选的保留各模型原值。应用后需保存上游。")}</DialogDescription>
        </DialogHeader>
        <ScrollArea type="always" className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <form id="bulk-model-form" className="grid min-w-0 gap-4 pr-3 pb-2" onSubmit={(event) => {
          event.preventDefault();
          setError(onApply(values) ?? null);
        }}>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Checkbox checked={values.changeMultiplier} onCheckedChange={(checked) => setValues({ ...values, changeMultiplier: checked === true })} />
              {" "}{t("设置模型整体倍率")}{" "}
            </Label>
            <Input aria-label={t("批量模型整体倍率")} inputMode="decimal" disabled={!values.changeMultiplier}
              value={values.multiplier} onChange={(event) => setValues({ ...values, multiplier: event.target.value })} />
          </div>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Checkbox checked={values.changeOffPeak} onCheckedChange={(checked) => setValues({ ...values, changeOffPeak: checked === true })} />
              {" "}{t("设置谷时倍率（峰时 = 1）")}{" "}
            </Label>
            <Input aria-label={t("批量谷时倍率")} inputMode="decimal" disabled={!values.changeOffPeak}
              value={values.offPeakMultiplier} onChange={(event) => setValues({ ...values, offPeakMultiplier: event.target.value })} />
            <p className="text-xs text-muted-foreground">{t("仅修改谷时倍率时保留各模型峰值时段；没有时段的模型需要同时设置时段。")}</p>
          </div>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2">
              <Checkbox checked={values.changeWindows} onCheckedChange={(checked) => setValues({ ...values, changeWindows: checked === true })} />
              {" "}{t("设置峰值时段")}{" "}
            </Label>
            <Textarea aria-label={t("批量峰值时段")} rows={4} disabled={!values.changeWindows}
              className="font-mono text-xs" placeholder={"1-5 01:00-09:00\n0,6 12:00-14:00"}
              value={values.peakWindows} onChange={(event) => setValues({ ...values, peakWindows: event.target.value })} />
            <p className="text-xs text-muted-foreground">{t("UTC，每行一个时段，星期 0 = 周日。留空清除自定义峰谷配置并恢复继承。")}</p>
          </div>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        </form>
        </ScrollArea>
        <DialogFooter className="shrink-0">
          <Button type="button" variant="outline" onClick={onClose}>{t("取消")}</Button>
          <Button type="submit" form="bulk-model-form">{t("应用到所选模型")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

export function UpstreamsManager({ upstreams }: { upstreams: UpstreamDoc[] }) {
  const t = useTranslator();
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
  const [modelSearch, setModelSearch] = useState("");
  const [unconfiguredOnly, setUnconfiguredOnly] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [catalogMeta, setCatalogMeta] = useState<CatalogMeta>({});
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  /** 当前表单上游的报价快照（探测回填 / 编辑时载入），保存时随 PUT 提交。 */
  const [modelPrices, setModelPrices] = useState<PriceMap>({});
  const [editingModelMeta, setEditingModelMeta] = useState<Record<string, UpstreamModelMeta>>({});
  const [metaDrafts, setMetaDrafts] = useState<Record<string, MetaDraft>>({});
  const [catalogCapabilities, setCatalogCapabilities] = useState<CatalogMetadataMap>({});
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
        if (!response.ok) throw new Error(t("模型目录获取失败"));
        const payload = (await response.json()) as {
          metadata?: Record<string, UpstreamModelMeta>;
          models?: CatalogMetadataMap;
        };
        if (!cancelled && payload.metadata) {
          setCatalogMeta(payload.metadata);
          setCatalogCapabilities(payload.models ?? {});
          setCatalogLoaded(Object.keys(payload.metadata).length > 0 || Object.keys(payload.models ?? {}).length > 0);
        }
      } catch {
        if (!cancelled) toast.error(t("模型目录获取失败，请点击更新元数据重试。"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

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
    setModelSearch("");
    setUnconfiguredOnly(false);
    setEditingModelMeta({});
    setMetaDrafts({});
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
    setModelSearch("");
    setUnconfiguredOnly(false);
    setEditingModelMeta(upstream.modelMeta ?? {});
    setMetaDrafts({});
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
    setMetaDrafts((values) => omitModels(values, removed));
    setTestResults((values) => omitModels(values, removed));
    setEditingModelId((current) => current && removed.has(current) ? null : current);
    setFormError(null);
  }

  function disableCheckedModels() {
    const checked = new Set(visibleCheckedModels);
    setSelectedModels((models) => models.filter((id) => !checked.has(id)));
    setDisabledModels((models) => [...new Set([...models, ...checked])]);
    toast.success(t("已停用 {0} 个模型，保存上游后生效。", { "0": checked.size }));
  }

  function applyBulkEdit(values: BulkEditValues): string | undefined {
    try {
      const patches = buildBulkEditDrafts(bulkEditingModels, values, (id) => pricingDraft(id).timeBased, t);
      setMetaDrafts((drafts) => {
        const next = { ...drafts };
        for (const [id, patch] of Object.entries(patches)) {
          next[id] = { ...next[id], ...patch };
        }
        return next;
      });
      setBulkEditingModels([]);
      toast.success(t("已更新 {0} 个模型，保存上游后生效。", { "0": bulkEditingModels.length }));
    } catch (error) {
      return error instanceof Error ? error.message : t("批量编辑失败。");
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
    setModelSearch("");
    setUnconfiguredOnly(false);
  }

  async function fetchFormModels() {
    if (!form.baseUrl) {
      setFormError(t("请先填写 Base URL。"));
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
        setFormError(payload?.error ?? t("拉取失败，请稍后重试。"));
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
          t("发现 {0} 个模型（已启用），其中 {1} 个带上游报价", { "0": payload.models.length, "1": Object.keys(prices).length }),
        );
      } else {
        toast.success(t("发现 {0} 个模型（已启用）", { "0": payload.models.length }));
      }
    } catch {
      setFormError(t("网络错误，请稍后重试。"));
    } finally {
      setFetchingModels(false);
    }
  }

  /** 从 pi-catalog 更新元数据：强制刷新服务端 24h 缓存并更新本页显示，
   *  不改变任何模型的自定义配置与上游自报报价。 */
  async function updateMetaFromCatalog() {
    setFormError(null);
    try {
      const response = await fetch("/api/admin/models/metadata?refresh=1");
      if (!response.ok) {
        setFormError(t("元数据拉取失败，请稍后重试。"));
        return;
      }
      const payload = (await response.json()) as {
        metadata?: Record<string, UpstreamModelMeta>;
        models?: CatalogMetadataMap;
      };
      const metadata = payload.metadata ?? {};
      if (Object.keys(metadata).length === 0) {
        toast.error(t("pi-catalog 无可用元数据（服务器可能无法访问 pi.dev）"));
        return;
      }
      setCatalogMeta(metadata);
      setCatalogCapabilities(payload.models ?? {});
      setCatalogLoaded(true);
      toast.success(t("已从 pi-catalog 更新 {0} 个模型的元数据", { "0": Object.keys(metadata).length }));
    } catch {
      setFormError(t("网络错误，请稍后重试。"));
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
   * 沿用基础倍率（输入框占位符显示基础值）。旧 override=false 的休眠价格不回显。
   */
  function rateDraftOf(modelId: string): {
    inputRate: string;
    cacheReadRate: string;
    cacheWriteRate: string;
    outputRate: string;
  } {
    const draft = metaDrafts[modelId];
    const stored = editingModelMeta[modelId]?.override === false ? undefined : editingModelMeta[modelId];
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

  function capabilityDraftOf(modelId: string): Record<CapabilityKey, string> {
    const stored = editingModelMeta[modelId];
    return Object.fromEntries(CAPABILITY_FIELDS.map(({ key }) => {
      const value = stored?.[key];
      return [key, metaDrafts[modelId]?.[key] ?? (Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value))];
    })) as Record<CapabilityKey, string>;
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

  function rowDisplayName(modelId: string): string {
    return resolveModelCapabilities(modelId, catalogCapabilities, {
      catalogModelId: rowCatalogModelId(modelId),
      displayName: (metaDrafts[modelId]?.displayName ?? editingModelMeta[modelId]?.displayName)?.trim() || null,
    }).displayName ?? modelId;
  }

  function rowUnconfigured(modelId: string): boolean {
    if (!catalogLoaded) return false;
    const target = rowCatalogModelId(modelId);
    if (catalogModelDefault(modelId, catalogCapabilities, target)
      || catalogModelDefault(modelId, catalogMeta, target)) return false;
    if (Object.values(capabilityDraftOf(modelId)).some((value) => value.trim())) return false;
    if (Object.values(rateDraftOf(modelId)).some((value) => value.trim())) return false;
    const draft = metaDrafts[modelId];
    const stored = editingModelMeta[modelId];
    const multiplier = draft?.multiplier ?? stored?.multiplier;
    if (multiplier != null && String(multiplier).trim()) return false;
    const tiers = draft?.tiers ?? stored?.tiers;
    const schedule = draft?.timeBased !== undefined ? draftScheduleToMeta(draft.timeBased) : stored?.timeBased;
    return !(tiers?.length || schedule);
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
      cacheReadRate: priceRead ?? round4(inputRate * cacheReadDiscount),
      cacheWriteRate: priceWrite ?? round4(inputRate * cacheWriteDiscount),
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

  /** 生效元数据：草稿/自定义逐腿覆盖，上游报价 > catalog 为缺省来源。
   *  留空继承，显式 0 = 免费，全部缺失时按 1x。
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
    const stored = editingModelMeta[modelId]?.override === false ? undefined : editingModelMeta[modelId];
    const structure = editingModelMeta[modelId];
    const draft = metaDrafts[modelId];
    const extras = {
      tiers: draft?.tiers !== undefined
        ? draftTiersToMeta(draft.tiers) ?? fallback.tiers
        : structure?.tiers ?? fallback.tiers,
      timeBased: draft?.timeBased !== undefined
        ? draftScheduleToMeta(draft.timeBased) ?? fallback.timeBased
        : structure?.timeBased ?? fallback.timeBased,
    };
    const pickRate = (
      draftValue: string | undefined,
      storedValue: number | null | undefined,
      defaultValue: number,
    ): number => {
      if (draftValue !== undefined) {
        const parsed = parseRateInput(draftValue);
        return !draftValue.trim() ? defaultValue : parsed === "invalid" ? (storedValue ?? defaultValue) : parsed;
      }
      return storedValue ?? defaultValue;
    };
    const inputRate = pickRate(draft?.inputRate, stored?.inputRate, fallback.inputRate);
    return {
      inputRate,
      // 每条腿独立覆盖；未填写的缓存腿保留继承倍率。
      cacheReadRate: draft?.cacheReadRate !== undefined || stored?.cacheReadRate != null
        ? pickRate(draft?.cacheReadRate, stored?.cacheReadRate, fallback.cacheReadRate)
        : fallback.cacheReadRate,
      cacheWriteRate: draft?.cacheWriteRate !== undefined || stored?.cacheWriteRate != null
        ? pickRate(draft?.cacheWriteRate, stored?.cacheWriteRate, fallback.cacheWriteRate)
        : fallback.cacheWriteRate,
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
      for (const key of ["contextWindow", "maxOutputTokens"] as const) {
        const value = draft[key]?.trim();
        if (value && (!Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
          setFormError(t("模型 {0} 的 {1} 必须为正整数或留空。", { "0": modelId, "1": key }));
          return;
        }
      }
      if (badRate) {
        setFormError(t("模型 {0} 的倍率必须是非负数字。", { "0": modelId }));
        return;
      }
      if (draft.multiplier !== undefined && parseMultiplierInput(draft.multiplier) === "invalid") {
        setFormError(t("模型 {0} 的整体倍率必须是非负数字。", { "0": modelId }));
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
            setFormError(t("模型 {0} 的长上下文阈值必须是正整数。", { "0": modelId }));
            return;
          }
          const badTierRate = [tier.inputRate, tier.cacheReadRate, tier.cacheWriteRate, tier.outputRate]
            .some((value) => value.trim() !== "" && parseRateInput(value) === "invalid");
          if (badTierRate) {
            setFormError(t("模型 {0} 的长上下文倍率必须是非负数字。", { "0": modelId }));
            return;
          }
        }
      }
      if (draft.timeBased) {
        const parsedWindows = parsePeakWindows(draft.timeBased.peakWindows, t);
        if ("error" in parsedWindows) {
          setFormError(t("模型 {0}：{1}", { "0": modelId, "1": parsedWindows.error }));
          return;
        }
        const offPeak = Number(draft.timeBased.offPeakMultiplier.trim());
        if (draft.timeBased.offPeakMultiplier.trim() !== "" && (!Number.isFinite(offPeak) || offPeak < 0)) {
          setFormError(t("模型 {0} 的谷时系数必须是非负数字。", { "0": modelId }));
          return;
        }
      }
    }
    const providerMultiplier = parseMultiplierInput(form.multiplier);
    if (providerMultiplier === "invalid") {
      setFormError(t("上游整体倍率必须是非负数字。"));
      return;
    }
    const modelMeta: Record<string, UpstreamModelMeta> = {};
    for (const modelId of tableModelIds) {
      const draft = metaDrafts[modelId];
      const hasDraft = draft !== undefined && Object.keys(draft).length > 0;
      if (editingModelMeta[modelId] === undefined && !hasDraft) {
        continue;
      }
      const entry: UpstreamModelMeta = {
        ...(rowCatalogModelId(modelId) ? { catalogModelId: rowCatalogModelId(modelId) } : {}),
      };
      const rateDraft = rateDraftOf(modelId);
      for (const field of ["inputRate", "cacheReadRate", "cacheWriteRate", "outputRate"] as const) {
        if (rateDraft[field].trim()) entry[field] = Number(rateDraft[field]);
      }
      const capabilityDraft = capabilityDraftOf(modelId);
      for (const field of CAPABILITY_FIELDS) {
        const text = capabilityDraft[field.key].trim();
        if (!text) continue;
        const value = field.kind === "boolean" ? text === "true" : field.kind === "number" ? Number(text)
          : field.kind === "list" ? [...new Set(text.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))] : text;
        Object.assign(entry, { [field.key]: value });
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
        setFormError(body?.error ?? t("保存失败，请稍后重试。"));
        return;
      }
      setShowForm(false);
      router.refresh();
    } catch {
      setFormError(t("网络错误，请稍后重试。"));
    } finally {
      setBusy(false);
    }
  }

  async function removeUpstream(upstream: UpstreamDoc) {
    if (!window.confirm(t("确定删除上游「{0}」？", { "0": upstream.name }))) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/upstreams/${upstream._id}`, { method: "DELETE" });
      if (!response.ok) {
        setError(t("删除失败。"));
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
      setError(t("该上游未配置模型。"));
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
      if (meta && meta.override !== false) {
        const inputRate = meta.inputRate ?? fallbackInput;
        return {
          inputRate,
          cacheReadRate: meta.cacheReadRate ?? fallbackCache,
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
          [upstream._id]: { ok: false, text: payload?.error ?? t("测试失败。") },
        }));
        return;
      }
      setListTestResults((results) => ({
        ...results,
        [upstream._id]: { ok: true, text: `${cheapest}（${payload.latencyMs} ms）` },
      }));
    } catch {
      setListTestResults((results) => ({ ...results, [upstream._id]: { ok: false, text: t("网络错误。") } }));
    } finally {
      setListTestingId(null);
    }
  }

  /** 对单个模型发一次最小 chat completion，结果内联显示在该行测试按钮下。 */
  async function testModel(modelId: string, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
    if (!form.baseUrl) {
      setFormError(t("请先填写 Base URL。"));
      return { ok: false, text: t("请先填写 Base URL。") };
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
      if (signal?.aborted) return { ok: false, text: t("测试已停止。") };
      if (!response.ok || typeof payload?.latencyMs !== "number") {
        const failed = { ok: false, text: payload?.error ?? t("测试失败。") };
        setTestResults((results) => ({ ...results, [modelId]: failed }));
        return failed;
      }
      const passed = { ok: true, text: `${payload.latencyMs} ms` };
      setTestResults((results) => ({ ...results, [modelId]: passed }));
      return passed;
    } catch {
      if (signal?.aborted) return { ok: false, text: t("测试已停止。") };
      const failed = { ok: false, text: t("网络错误。") };
      setTestResults((results) => ({ ...results, [modelId]: failed }));
      return failed;
    } finally {
      setTestingModel(null);
    }
  }

  async function testCheckedModels() {
    if (!form.baseUrl) {
      setFormError(t("请先填写 Base URL。"));
      return;
    }
    const ids = [...visibleCheckedModels];
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
      const summary = t("{0}：{1}/{2}，成功 {3}，失败 {4}", { "0": controller.signal.aborted ? t("测试已停止") : t("批量测试完成"), "1": completed, "2": ids.length, "3": passed, "4": completed - passed });
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
  const rowFacts = withModelDisplayNames(new Map(sortedDiscovered.map((modelId) => [modelId, {
    displayName: rowDisplayName(modelId),
    unconfigured: rowUnconfigured(modelId),
  }] as const)));
  const checkedSet = new Set(checkedModels);
  const searchTerms = modelSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visibleModelIds = sortedDiscovered.filter((modelId) => {
    if (unconfiguredOnly && !rowFacts.get(modelId)?.unconfigured) return false;
    const text = `${modelId} ${rowFacts.get(modelId)?.displayName}`.toLowerCase();
    return searchTerms.every((term) => text.includes(term));
  });
  const unconfiguredCount = [...rowFacts.values()].filter((row) => row.unconfigured).length;
  const visibleCheckedModels = visibleModelIds.filter((id) => checkedSet.has(id));
  const checkedCount = visibleCheckedModels.length;
  const hiddenCheckedCount = tableModelIds.filter((id) => checkedSet.has(id)).length - checkedCount;
  const allChecked = visibleModelIds.length > 0 && checkedCount === visibleModelIds.length;
  const modelActionsBusy = busy || testingModel !== null || batchTestProgress !== null;
  return (
    <div className="grid gap-4">
      <div>
        <Button onClick={startCreate}>
          <Plus />
          {" "}{t("新增上游")}{" "}
        </Button>
      </div>

      <BaseModelPicker />

      <Dialog open={showForm} onOpenChange={setFormOpen}>
        <DialogContent className="flex h-[calc(100dvh-6rem)] flex-col overflow-hidden sm:max-w-5xl">
          <DialogHeader className="shrink-0 pr-8">
            <DialogTitle>{editingId ? t("编辑上游") : t("新增上游")}</DialogTitle>
            <DialogDescription>
              {" "}{t("填写模型服务的接口地址，例如")}{" "}
              <code className="font-mono text-xs">https://api.example.com/v1</code> {" "}{t("或")}{" "}
              <code className="font-mono text-xs">https://generativelanguage.googleapis.com/v1beta</code>
              {" "}{t("；协议决定请求与响应的格式（「跟随客户端」把调用方的请求与上游返回原样透传，不做协议转换）； 优先级数字越小越优先，同一模型有多个来源时会自动按优先级切换。")}{" "}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea type="always" className="-mx-4 min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]]:overscroll-contain [&_[data-slot=table-container]]:overflow-visible">
          <form id="upstream-form" className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 px-4 pb-3" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-2">
                <Label htmlFor="upstream-name">{t("名称")}</Label>
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
                <Label htmlFor="upstream-format">{t("上游协议")}</Label>
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
                        {t(API_FORMAT_LABELS[value])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-priority">{t("优先级")}</Label>
                <Input
                  id="upstream-priority"
                  type="number"
                  min={0}
                  value={form.priority}
                  onChange={(event) => setForm({ ...form, priority: event.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-enabled">{t("启用")}</Label>
                <Select value={form.enabled} onValueChange={(value) => setForm({ ...form, enabled: value })}>
                  <SelectTrigger id="upstream-enabled" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t("启用")}</SelectItem>
                    <SelectItem value="0">{t("停用")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="upstream-multiplier">{t("上游整体倍率")}</Label>
                <Input
                  id="upstream-multiplier"
                  inputMode="decimal"
                  className="font-mono text-xs tabular-nums"
                  placeholder="1"
                  value={form.multiplier}
                  onChange={(event) => setForm({ ...form, multiplier: event.target.value })}
                />
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
                  {fetchingModels ? t("拉取中…") : t("从上游拉取")}
                </Button>
                <div className="flex items-center gap-1.5">
                  <Input
                    placeholder={t("手动添加 model-id")}
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
                    {" "}{t("添加")}{" "}
                  </Button>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={updateMetaFromCatalog}>
                  <ArrowDownToLine />
                  {" "}{t("更新元数据")}{" "}
                </Button>
              </div>
            </div>

            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Input aria-label={t("搜索模型 ID 或显示名")} placeholder={t("搜索模型 ID 或显示名…")} className="h-8 min-w-40 flex-1 text-xs" value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
                <Button type="button" variant={unconfiguredOnly ? "secondary" : "outline"} size="sm" aria-pressed={unconfiguredOnly} disabled={!catalogLoaded} onClick={() => setUnconfiguredOnly((value) => !value)}>{t("仅看未配置（")}{unconfiguredCount}）</Button>
                {modelSearch || unconfiguredOnly ? <Button type="button" variant="ghost" size="sm" onClick={() => { setModelSearch(""); setUnconfiguredOnly(false); }}>{t("清除筛选")}</Button> : null}
                <span className="text-xs text-muted-foreground">{t("显示")}{" "}{visibleModelIds.length} / {tableModelIds.length}</span>
              </div>
              {tableModelIds.length > 0 ? (
                <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-popover p-2">
                  <span className="text-xs text-muted-foreground">{t("当前结果已选")}{" "}{checkedCount} / {visibleModelIds.length}</span>
                  {hiddenCheckedCount > 0 ? <span className="text-xs text-muted-foreground">{t("筛选外已选")}{" "}{hiddenCheckedCount}{t("（不参与本次批量操作）")}</span> : null}
                  <Button type="button" variant="outline" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => void testCheckedModels()}>{t("批量测试")}</Button>
                  <Button type="button" variant="outline" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={disableCheckedModels}>{t("批量停用")}</Button>
                  <Button type="button" variant="outline" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => setBulkEditingModels([...visibleCheckedModels])}>{t("批量编辑")}</Button>
                  <Button type="button" variant="destructive" size="sm" disabled={modelActionsBusy || checkedCount === 0}
                    onClick={() => setPendingDeleteModels([...visibleCheckedModels])}>{t("批量删除")}</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={modelActionsBusy || checkedCount + hiddenCheckedCount === 0}
                    onClick={() => setCheckedModels([])}>{t("取消选择")}</Button>
                  {batchTestProgress ? (
                    <>
                      <span className="text-xs tabular-nums" role="status">
                        {" "}{t("已测试")}{" "}{batchTestProgress.completed} / {batchTestProgress.total}
                      </span>
                      <Button type="button" variant="outline" size="sm" onClick={() => batchTestController.current?.abort()}>{t("停止测试")}</Button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {tableModelIds.length > 0 ? (
                <div className="min-w-0 rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox aria-label={t("全选当前筛选结果用于批量操作")} disabled={modelActionsBusy || visibleModelIds.length === 0}
                            checked={allChecked ? true : checkedCount > 0 ? "indeterminate" : false}
                            onCheckedChange={(checked) => setCheckedModels((current) => checked === true ? [...new Set([...current, ...visibleModelIds])] : current.filter((id) => !visibleModelIds.includes(id)))} />
                        </TableHead>
                        <TableHead>{t("模型 ID")}</TableHead>
                        <TableHead>{t("显示名")}</TableHead>
                        <TableHead className="w-40">{t("当前倍率")}</TableHead>
                        <TableHead className="w-56 text-right">{t("操作")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleModelIds.length === 0 ? <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">{t("没有匹配的模型，请调整搜索或筛选条件。")}</TableCell></TableRow> : null}
                      {visibleModelIds.map((modelId) => {
                        const displayName = rowFacts.get(modelId)?.displayName ?? modelId;
                        const rowDisabled = disabledModels.includes(modelId);
                        const enabled = selectedModels.includes(modelId);
                        const effective = effectiveMeta(modelId);
                        const meta = resolvedMeta(modelId);
                        const tiers = meta.tiers ?? [];
                        const hasExtras = tiers.length > 0 || meta.timeBased !== undefined;
                        return (
                          <TableRow key={modelId} data-state={checkedSet.has(modelId) ? "selected" : undefined}>
                            <TableCell>
                              <Checkbox aria-label={t("选择模型 {0}", { "0": modelId })} checked={checkedSet.has(modelId)} disabled={modelActionsBusy}
                                onCheckedChange={(checked) => setCheckedModels((models) => checked === true
                                  ? [...new Set([...models, modelId])]
                                  : models.filter((id) => id !== modelId))} />
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {modelId}
                              {rowFacts.get(modelId)?.unconfigured ? (
                                <Badge variant="outline" className="ml-2 border-orange-500/40 bg-orange-500/10 font-sans text-[10px] text-orange-700 dark:text-orange-300" title={t("未匹配到 catalog，且未手动配置模型元数据或倍率")}>
                                  {" "}{t("未配置")}{" "}
                                </Badge>
                              ) : null}
                              {rowDisabled ? (
                                <Badge variant="secondary" className="ml-2 font-sans text-[10px]">
                                  {" "}{t("已停用")}{" "}
                                </Badge>
                              ) : null}
                              {hasUpstreamPrice(modelId) ? (
                                <Badge
                                  variant="outline"
                                  className="ml-2 font-sans text-[10px]"
                                  title={t("该上游的 /v1/models 自报了价格，解析时优先于 pi-catalog")}
                                >
                                  {" "}{t("上游报价")}{" "}
                                </Badge>
                              ) : null}
                            </TableCell>
                            <TableCell className="max-w-64 text-sm">
                              <span className="block truncate" title={displayName}>{displayName}</span>
                            </TableCell>
                            <TableCell className="font-mono text-xs tabular-nums">
                              <span
                                title={t("四腿顺序：输入 / 缓存读取 / 缓存写入 / 输出{0}", { "0": hasExtras ? t("（已含阶梯与峰谷配置）") : "" })}
                              >
                                {[effective.inputRate, effective.cacheReadRate, effective.cacheWriteRate, effective.outputRate].map((rate) => rateDisplayFormat.format(rate)).join(" / ")}
                              </span>
                              {hasExtras ? (
                                <span className="ml-1 font-sans text-[10px] text-muted-foreground">
                                  {tiers.length > 0 ? t("阶梯×{0}", { "0": tiers.length }) : null}
                                  {tiers.length > 0 && meta.timeBased ? " · " : null}
                                  {meta.timeBased ? t("峰谷×{0}", { "0": meta.timeBased.offPeakMultiplier }) : null}
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
                                  {" "}{t("编辑")}{" "}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2.5 text-xs"
                                  disabled={modelActionsBusy}
                                  onClick={() => void testModel(modelId)}
                                >
                                  {testingModel === modelId ? t("测试中…") : t("测试")}
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
                                    {" "}{t("启用")}{" "}
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
                                    {" "}{t("停用")}{" "}
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
                                  {" "}{t("删除")}{" "}
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
          <ScrollBar orientation="horizontal" />
          </ScrollArea>
          <DialogFooter className="relative z-20 shrink-0">
            <Button type="submit" form="upstream-form" disabled={modelActionsBusy}>
              {editingId ? t("保存") : t("创建")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
              {" "}{t("取消")}{" "}
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
          catalogCapabilities={catalogCapabilities}
          capabilities={capabilityDraftOf(editingModelId)}
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
          onClose={() => setEditingModelId(null)}
        />
      ) : null}

      {bulkEditingModels.length > 0 ? (
        <BulkModelEditor modelIds={bulkEditingModels} onApply={applyBulkEdit} onClose={() => setBulkEditingModels([])} />
      ) : null}

      <AlertDialog open={pendingDeleteModels.length > 0} onOpenChange={(open) => { if (!open) setPendingDeleteModels([]); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("删除")}{" "}{pendingDeleteModels.length} {" "}{t("个模型？")}</AlertDialogTitle>
            <AlertDialogDescription>
              {" "}{t("将从此上游移除所选模型及其自定义配置、目录目标和上游报价，保存上游后生效。")}{" "}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              removeFormModels(pendingDeleteModels);
              setPendingDeleteModels([]);
            }}>{t("删除")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("上游列表")}</CardTitle>
          <CardDescription>{t("按优先级升序排列。")}</CardDescription>
        </CardHeader>
        <CardContent>
          {upstreams.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {" "}{t("还没有上游，点击「新增上游」添加第一个模型服务。")}{" "}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("名称")}</TableHead>
                  <TableHead>Base URL</TableHead>
                  <TableHead>{t("协议")}</TableHead>
                  <TableHead>{t("优先级")}</TableHead>
                  <TableHead>{t("模型")}</TableHead>
                  <TableHead>{t("状态")}</TableHead>
                  <TableHead className="text-right">{t("操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upstreams.map((upstream) => (
                  <TableRow key={upstream._id}>
                    <TableCell className="font-medium">{upstream.name}</TableCell>
                    <TableCell className="max-w-52 font-mono text-xs break-all">{upstream.baseUrl}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {t(API_FORMAT_LABELS[(upstream.apiFormat ?? "auto") as UpstreamApiFormatValue])}
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
                        {upstream.enabled ? t("启用") : t("停用")}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => startEdit(upstream)}>
                          {" "}{t("编辑")}{" "}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={listTestingId === upstream._id}
                          onClick={() => overallTest(upstream)}
                        >
                          <Activity />
                          {listTestingId === upstream._id ? t("测试中…") : t("整体测试")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => removeUpstream(upstream)}
                        >
                          {" "}{t("删除")}{" "}
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
                  「{upstream.name}{t("」整体测试")}{listTestResults[upstream._id].ok ? t("通过") : t("失败")}
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
