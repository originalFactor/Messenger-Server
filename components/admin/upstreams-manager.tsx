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
import type { UpstreamDoc, UpstreamModelMeta } from "@/lib/types";
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

type DevMeta = Record<string, UpstreamModelMeta>;
/** 草稿只记录用户动过的字段；未触碰字段缺省，由生效值解析兜底。 */
interface MetaDraft {
  inputRate?: string;
  cacheReadRate?: string;
  outputRate?: string;
  /** 模型整体倍率（modelRate）草稿；空串 = 1。 */
  multiplier?: string;
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

  const [devMeta, setDevMeta] = useState<DevMeta>({});
  const [editingModelMeta, setEditingModelMeta] = useState<Record<string, UpstreamModelMeta>>({});
  const [metaDrafts, setMetaDrafts] = useState<Record<string, MetaDraft>>({});
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, boolean>>({});
  const [listTestingId, setListTestingId] = useState<string | null>(null);
  const [listTestResults, setListTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  // models.dev 元数据（含上下文与归一化倍率），页面加载时拉取一次。
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
          setDevMeta(payload.metadata);
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
    setTestResults({});
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
    setTestResults({});
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

  /** 从表中彻底删除模型：同时移除 models、停用列表与已存元数据。 */
  function deleteFormModel(modelId: string) {
    if (!window.confirm(`确定从该上游删除模型「${modelId}」？`)) {
      return;
    }
    setSelectedModels((selected) => selected.filter((value) => value !== modelId));
    setDiscoveredModels((models) => models.filter((value) => value !== modelId));
    setDisabledModels((disabled) => disabled.filter((value) => value !== modelId));
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
        error?: string;
      } | null;
      if (!response.ok || !payload?.models) {
        setFormError(payload?.error ?? "拉取失败，请稍后重试。");
        return;
      }
      setDiscoveredModels((models) =>
        [...new Set([...models, ...payload.models ?? []])].sort((a, b) => a.localeCompare(b)),
      );
      toast.success(`发现 ${payload.models.length} 个模型，勾选后保存即可`);
    } catch {
      setFormError("网络错误，请稍后重试。");
    } finally {
      setFetchingModels(false);
    }
  }

  /** 从 models.dev 更新元数据：强制刷新服务端 24h 缓存并更新本页显示，
   *  不改变任何模型的覆盖开关。 */
  async function updateMetaFromModelsDev() {
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
        toast.error("models.dev 无可用元数据（服务器可能无法访问 models.dev）");
        return;
      }
      setDevMeta((meta) => ({ ...meta, ...metadata }));
      toast.success(`已从 models.dev 更新 ${Object.keys(metadata).length} 个模型的元数据`);
    } catch {
      setFormError("网络错误，请稍后重试。");
    }
  }

  function metaDraftOf(modelId: string): MetaDraft {
    return metaDrafts[modelId] ?? {};
  }

  /** 按模型覆盖开关：行草稿 > 已存自定义 > 默认关闭（用 models.dev）。 */
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

  /** 生效元数据（按模型）：覆盖开启时 草稿 > 自定义 > models.dev > 0（0 = 不计费）；
   *  关闭时（默认使用 models.dev 数据）models.dev 缺失或为 0 时按 1x 展示。
   *  返回值为 tokenType 倍率（未含 modelRate / providerRate）。 */
  function resolvedMeta(modelId: string): {
    inputRate: number;
    cacheReadRate: number;
    outputRate: number;
  } {
    const dev = devMeta[modelId];
    if (!rowOverride(modelId)) {
      const devRate = dev?.inputRate;
      const devOutRate = dev?.outputRate;
      const devCacheRate = dev?.cacheReadRate;
      return {
        inputRate: devRate && devRate > 0 ? devRate : 1,
        // 缓存读取缺失按输入价计（不收缓存折扣的供应商即如此）。
        cacheReadRate: devCacheRate && devCacheRate > 0 ? devCacheRate : (devRate && devRate > 0 ? devRate : 1),
        outputRate: devOutRate && devOutRate > 0 ? devOutRate : 1,
      };
    }
    const stored = editingModelMeta[modelId];
    const draft = metaDrafts[modelId];
    const pickRate = (
      draftValue: string | undefined,
      storedValue: number | null | undefined,
      devValue: number | null | undefined,
    ): number => {
      if (draftValue !== undefined) {
        const parsed = parseRateInput(draftValue);
        return parsed === "invalid" ? (storedValue ?? devValue ?? 0) : parsed;
      }
      return storedValue ?? devValue ?? 0;
    };
    const inputRate = pickRate(draft?.inputRate, stored?.inputRate, dev?.inputRate);
    // 缓存价未自定义时沿用 models.dev 的折扣比例（cache ÷ input）而不是其
    // 绝对倍率 —— 与 lib/model-rates.ts 的解析口径保持一致。
    const devDiscount = dev?.inputRate && dev.inputRate > 0 && typeof dev.cacheReadRate === "number"
      ? dev.cacheReadRate / dev.inputRate
      : 1;
    return {
      inputRate,
      cacheReadRate: draft?.cacheReadRate !== undefined || stored?.cacheReadRate != null
        ? pickRate(draft?.cacheReadRate, stored?.cacheReadRate, dev?.cacheReadRate)
        : inputRate * devDiscount,
      outputRate: pickRate(draft?.outputRate, stored?.outputRate, dev?.outputRate),
    };
  }

  /** 生效倍率（含 modelRate × providerRate），用于展示实际计费口径。 */
  function effectiveMeta(modelId: string): {
    inputRate: number;
    cacheReadRate: number;
    outputRate: number;
  } {
    const base = resolvedMeta(modelId);
    const modelMultiplier = parseMultiplier(rowMultiplier(modelId));
    const providerMultiplier = parseMultiplier(form.multiplier);
    const scale = modelMultiplier * providerMultiplier;
    return {
      inputRate: base.inputRate * scale,
      cacheReadRate: base.cacheReadRate * scale,
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
        (draft.outputRate !== undefined && parseRateInput(draft.outputRate) === "invalid");
      if (badRate) {
        setFormError(`模型 ${modelId} 的倍率必须是数字。`);
        return;
      }
      if (draft.multiplier !== undefined && parseMultiplierInput(draft.multiplier) === "invalid") {
        setFormError(`模型 ${modelId} 的整体倍率必须是非负数字。`);
        return;
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
        inputRate: resolved.inputRate,
        outputRate: resolved.outputRate,
      };
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
    const rateOf = (modelId: string): { inputRate: number; cacheReadRate: number; outputRate: number } => {
      const dev = devMeta[modelId];
      const meta = upstream.modelMeta?.[modelId];
      const devDiscount = dev?.inputRate && dev.inputRate > 0 && typeof dev.cacheReadRate === "number"
        ? dev.cacheReadRate / dev.inputRate
        : 1;
      if (meta?.override) {
        const inputRate = meta.inputRate ?? dev?.inputRate ?? 1;
        return {
          inputRate,
          cacheReadRate: meta.cacheReadRate ?? inputRate * devDiscount,
          outputRate: meta.outputRate ?? dev?.outputRate ?? 1,
        };
      }
      return {
        inputRate: dev?.inputRate ?? 1,
        cacheReadRate: dev?.cacheReadRate ?? dev?.inputRate ?? 1,
        outputRate: dev?.outputRate ?? 1,
      };
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
  function rateDisplay(modelId: string, field: "inputRate" | "cacheReadRate" | "outputRate"): string {
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
                <Button type="button" variant="outline" size="sm" onClick={updateMetaFromModelsDev}>
                  <ArrowDownToLine />
                  从 models.dev 更新元数据
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
                        <TableHead className="w-24">输出倍率</TableHead>
                        <TableHead className="w-24">模型整体倍率</TableHead>
                        <TableHead className="w-28">实际倍率（生效）</TableHead>
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
                        // 覆盖开启：未触碰字段显示当前生效值（自定义 > models.dev > 0），
                        // 用户动过的字段（含主动清空 = 0）显示草稿原值。
                        const draft: MetaDraft = editable
                          ? {
                              inputRate: rawDraft.inputRate ?? String(meta.inputRate),
                              cacheReadRate: rawDraft.cacheReadRate ?? String(meta.cacheReadRate),
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
                                    {effective.inputRate} / {effective.cacheReadRate} / {effective.outputRate}
                                  </span>
                                );
                              })()}
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
