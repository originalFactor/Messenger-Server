"use client";

/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { useRouter } from "next/navigation";
import { useTranslator } from "@/components/i18n/locale-provider";
import type { Translator } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronRight, FolderKanban, Plus, Save, Server, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type { AgentDoc, ModelEmbed, ProjectDoc, ProviderDoc } from "@/lib/types";
import { ModelMetadataSummary, useModelMetadata } from "@/components/messenger/model-metadata";
import { ProviderModelsTable } from "@/components/messenger/provider-models-table";
import { ReasoningEffortSelect } from "@/components/messenger/reasoning-effort-select";
import { parseSamplingInputs } from "@/lib/sampling";
import { mergeProviderModels } from "@/lib/provider-model-metadata";
import type { PlazaModel } from "@/lib/model-plaza";

type Props = {
  initialAgents: AgentDoc[];
  initialProviders: ProviderDoc[];
  initialProjects: ProjectDoc[];
  builtinModels: PlazaModel[];
  onChange: (configuration: { agents: AgentDoc[]; providers: ProviderDoc[]; projects: ProjectDoc[] }) => void;
};

type Tab = "agents" | "providers" | "projects";

type AgentDraft = {
  id: string;
  name: string;
  systemPrompt: string;
  description: string;
  role: "default" | "chat" | "title";
  selectedProviderId: string;
  defaultModelId: string;
  temperature: string;
  topP: string;
  frequencyPenalty: string;
  presencePenalty: string;
  maxTokens: string;
  reasoningEffort: string;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultFrequencyPenalty: boolean;
  followDefaultPresencePenalty: boolean;
  followDefaultMaxTokens: boolean;
  followDefaultReasoningEffort: boolean;
  createdAt: number;
};

type ProviderDraft = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: "chat" | "responses" | "messages" | "interactions" | "auto";
  models: ModelEmbed[];
  createdAt: number;
};

type ProjectDraft = {
  id: string;
  name: string;
  workspace: string;
  createdAt: number;
};

function now() {
  return Date.now();
}

const BUILTIN_PROVIDER_ID = "builtin-messenger-cloud-ai";

function newAgent(t: Translator): AgentDraft {
  return {
    id: crypto.randomUUID(),
    name: t("新 Agent"),
    systemPrompt: "You are a helpful assistant.",
    description: "",
    role: "chat",
    selectedProviderId: "",
    defaultModelId: "",
    temperature: "",
    topP: "",
    frequencyPenalty: "",
    presencePenalty: "",
    maxTokens: "",
    reasoningEffort: "",
    isDefault: false,
    followDefaultSystemPrompt: false,
    followDefaultModel: false,
    followDefaultTemperature: false,
    followDefaultTopP: false,
    followDefaultFrequencyPenalty: false,
    followDefaultPresencePenalty: false,
    followDefaultMaxTokens: false,
    followDefaultReasoningEffort: false,
    createdAt: now(),
  };
}

function agentDraft(agent: AgentDoc, providerId = ""): AgentDraft {
  return {
    id: agent._id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    description: agent.description ?? "",
    role: agent.isDefault ? "default" : agent.role === "title" ? "title" : "chat",
    selectedProviderId: providerId,
    defaultModelId: agent.defaultModelId ?? "",
    temperature: agent.temperatureEnabled === false ? "" : String(agent.temperature),
    topP: agent.topPEnabled === false ? "" : String(agent.topP),
    frequencyPenalty: agent.frequencyPenalty?.toString() ?? "",
    presencePenalty: agent.presencePenalty?.toString() ?? "",
    maxTokens: agent.maxTokens == null ? "" : String(agent.maxTokens),
    reasoningEffort: agent.reasoningEffort ?? "",
    isDefault: agent.isDefault,
    followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
    followDefaultModel: agent.followDefaultModel,
    followDefaultTemperature: agent.followDefaultTemperature,
    followDefaultTopP: agent.followDefaultTopP,
    followDefaultFrequencyPenalty: agent.followDefaultFrequencyPenalty ?? false,
    followDefaultPresencePenalty: agent.followDefaultPresencePenalty ?? false,
    followDefaultMaxTokens: agent.followDefaultMaxTokens,
    followDefaultReasoningEffort: agent.followDefaultReasoningEffort,
    createdAt: agent.createdAt,
  };
}

function newProvider(t: Translator): ProviderDraft {
  return {
    id: crypto.randomUUID(),
    name: t("新 Provider"),
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    apiFormat: "chat",
    models: [],
    createdAt: now(),
  };
}

function providerDraft(provider: ProviderDoc): ProviderDraft {
  return {
    id: provider._id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    apiFormat: provider.apiFormat ?? "auto",
    models: provider.models,
    createdAt: provider.createdAt,
  };
}

function newProject(t: Translator): ProjectDraft {
  return { id: crypto.randomUUID(), name: t("新项目"), workspace: "", createdAt: now() };
}

function projectDraft(project: ProjectDoc): ProjectDraft {
  return { id: project._id, name: project.name, workspace: project.workspace, createdAt: project.createdAt };
}

async function readError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return payload?.error ?? fallback;
}

function FollowToggle({ id, label, checked, onCheckedChange }: { id: string; label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <Label htmlFor={id} className="text-xs font-normal text-muted-foreground">{label}</Label>
    </div>
  );
}

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const t = useTranslator();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive"><Trash2 /> {" "}{t("删除")}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("确定删除这个配置吗？")}</AlertDialogTitle>
          <AlertDialogDescription>{t("删除会同步到你的所有设备。")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>{t("删除")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ConfigurationManagement({ initialAgents, initialProviders, initialProjects, builtinModels, onChange }: Props) {
  const t = useTranslator();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("agents");
  const [agents, setAgents] = useState(initialAgents);
  const [providers, setProviders] = useState(initialProviders);
  const [projects, setProjects] = useState(initialProjects);

  useEffect(() => {
    onChange({ agents, providers, projects });
  }, [agents, providers, projects, onChange]);
  const builtinProvider = useMemo<ProviderDoc>(() => ({
    _id: BUILTIN_PROVIDER_ID,
    userId: "",
    name: t("Messenger Cloud AI（内置）"),
    baseUrl: "",
    apiKey: "",
    apiFormat: "chat",
    models: builtinModels.map((model) => ({
      id: `builtin:${model.modelId}`,
      modelId: model.modelId,
      displayName: model.displayName ?? model.modelId,
      isEnabled: true,
      contextWindow: model.metadata?.contextWindow ?? null,
      metadata: model.metadata,
      cacheReadRate: model.cacheReadRateMin,
      cacheWriteRate: model.cacheWriteRateMin,
      inputRate: model.inputRateMin,
      outputRate: model.outputRateMin,
      createdAt: 0,
    })),
    createdAt: 0,
    updatedAt: 0,
    version: 0,
    deleted: false,
  }), [builtinModels, t]);
  const initialAllProviders = [builtinProvider, ...initialProviders];
  const providerForModel = (modelId: string | null | undefined) =>
    initialAllProviders.find((item) => item.models.some((model) => model.modelId === modelId))?._id ?? "";
  const [agent, setAgent] = useState<AgentDraft | null>(() => initialAgents[0] ? agentDraft(initialAgents[0], providerForModel(initialAgents[0].defaultModelId)) : newAgent(t));
  const [provider, setProvider] = useState<ProviderDraft | null>(() => providerDraft(builtinProvider));
  const [probingModels, setProbingModels] = useState(false);
  const probeController = useRef<AbortController | null>(null);
  useEffect(() => () => { probeController.current?.abort(); }, [tab, provider?.id, provider?.baseUrl, provider?.apiKey, provider?.apiFormat]);

  const [project, setProject] = useState<ProjectDraft | null>(() => initialProjects[0] ? projectDraft(initialProjects[0]) : newProject(t));
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const allProviders = useMemo(() => [builtinProvider, ...providers], [builtinProvider, providers]);
  const modelIds = useMemo(() => allProviders.flatMap((item) => item.models.filter((model) => model.isEnabled).map((model) => model.modelId)), [allProviders]);
  const selectedAgentProvider = allProviders.find((item) => item._id === agent?.selectedProviderId);
  const selectedAgentModels = selectedAgentProvider?.models.filter((model) => model.isEnabled) ?? [];
  const canFollowDefaults = agent?.role !== "default";
  const defaultAgent = agents.find((item) => item.isDefault);
  const effectiveAgentModel = canFollowDefaults && agent?.followDefaultModel
    ? defaultAgent?.defaultModelId : agent?.defaultModelId;

  const cloudModel = (canFollowDefaults && agent?.followDefaultModel ? providerForModel(defaultAgent?.defaultModelId) : agent?.selectedProviderId) === BUILTIN_PROVIDER_ID;
  const modelMetadata = useModelMetadata(tab === "agents" ? effectiveAgentModel : null, cloudModel,
    allProviders.find((item) => item._id === (canFollowDefaults && agent?.followDefaultModel ? providerForModel(defaultAgent?.defaultModelId) : agent?.selectedProviderId))?.models.find((item) => item.modelId === effectiveAgentModel));
  const modelCapabilities = modelMetadata.metadata;

  const activeItems = tab === "agents" ? agents : tab === "providers" ? allProviders : projects;
  const visibleItems = activeItems.filter((item) => {
    const name = "name" in item ? item.name : "";
    return name.toLowerCase().includes(query.toLowerCase());
  });

  function selectItem(item: AgentDoc | ProviderDoc | ProjectDoc) {
    if (tab === "agents") {
      const selected = item as AgentDoc;
      setAgent(agentDraft(selected, providerForModel(selected.defaultModelId)));
    }
    if (tab === "providers") setProvider(providerDraft(item as ProviderDoc));
    if (tab === "projects") setProject(projectDraft(item as ProjectDoc));
  }

  function addItem() {
    if (tab === "agents") setAgent(newAgent(t));
    if (tab === "providers") setProvider(newProvider(t));
    if (tab === "projects") setProject(newProject(t));
  }

  async function saveAgent() {
    if (!agent) return;
    let sampling;
    try { sampling = parseSamplingInputs(agent, t); } catch (error) {
      toast.error(error instanceof Error ? error.message : t("采样参数无效"));
      return;
    }
    const maxTokens = agent.maxTokens ? Number(agent.maxTokens) : null;
    if (!agent.name.trim() || !agent.systemPrompt.trim()) {
      toast.error(t("请填写有效的 Agent 名称、提示词和采样参数。"));
      return;
    }
    const previousAgent = agents.find((item) => item._id === agent.id);
    const temperature = sampling.temperature ?? previousAgent?.temperature ?? 0.7;
    const topP = sampling.topP ?? previousAgent?.topP ?? 1;
    setSaving(true);
    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: agent.id,
          name: agent.name.trim(),
          systemPrompt: agent.systemPrompt,
          description: agent.description.trim() || null,
          defaultModelId: agent.defaultModelId.trim() || null,
          temperature,
          topP,
          temperatureEnabled: sampling.temperature !== null,
          topPEnabled: sampling.topP !== null,
          frequencyPenalty: sampling.frequencyPenalty,
          presencePenalty: sampling.presencePenalty,
          maxTokens: maxTokens == null || Number.isNaN(maxTokens) ? null : maxTokens,
          reasoningEffort: agent.reasoningEffort.trim() || null,
          isDefault: agent.role === "default",
          followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
          followDefaultModel: agent.followDefaultModel,
          followDefaultTemperature: agent.followDefaultTemperature,
          followDefaultTopP: agent.followDefaultTopP,
          followDefaultFrequencyPenalty: agent.followDefaultFrequencyPenalty,
          followDefaultPresencePenalty: agent.followDefaultPresencePenalty,
          followDefaultMaxTokens: agent.followDefaultMaxTokens,
          followDefaultReasoningEffort: agent.followDefaultReasoningEffort,
          role: agent.role === "title" ? "title" : "chat",
          // Tool settings are edited on the other clients; keep whatever is stored.
          toolsEnabled: previousAgent?.toolsEnabled ?? false,
          toolsFollowDefault: previousAgent?.toolsFollowDefault ?? false,
          toolsConfig: previousAgent?.toolsConfig ?? null,
          createdAt: agent.createdAt,
          updatedAt: now(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, t("保存 Agent 失败")));
      const previous = agents.find((item) => item._id === agent.id);
      const updated: AgentDoc = {
        _id: agent.id,
        userId: previous?.userId ?? "",
        name: agent.name.trim(),
        avatarUrl: previous?.avatarUrl ?? null,
        avatarVersion: previous?.avatarVersion ?? null,
        systemPrompt: agent.systemPrompt,
        description: agent.description.trim() || null,
        defaultModelId: agent.defaultModelId.trim() || null,
        temperature,
        topP,
        temperatureEnabled: sampling.temperature !== null,
        topPEnabled: sampling.topP !== null,
        frequencyPenalty: sampling.frequencyPenalty,
        presencePenalty: sampling.presencePenalty,
        maxTokens,
        reasoningEffort: agent.reasoningEffort.trim() || null,
        isDefault: agent.role === "default",
        role: agent.role === "default" ? null : agent.role,
        followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
        followDefaultModel: agent.followDefaultModel,
        followDefaultTemperature: agent.followDefaultTemperature,
        followDefaultTopP: agent.followDefaultTopP,
        followDefaultFrequencyPenalty: agent.followDefaultFrequencyPenalty,
        followDefaultPresencePenalty: agent.followDefaultPresencePenalty,
        followDefaultMaxTokens: agent.followDefaultMaxTokens,
        followDefaultReasoningEffort: agent.followDefaultReasoningEffort,
        marketAgentId: previous?.marketAgentId ?? null,
        marketAgentVersion: previous?.marketAgentVersion ?? null,
        marketAgentRole: previous?.marketAgentRole ?? null,
        toolsEnabled: previous?.toolsEnabled ?? false,
        toolsFollowDefault: previous?.toolsFollowDefault ?? false,
        toolsConfig: previous?.toolsConfig ?? null,
        createdAt: agent.createdAt,
        updatedAt: now(),
        version: previous?.version ?? 0,
        deleted: false,
      };
      setAgents((current) => {
        const exists = current.some((item) => item._id === updated._id);
        return exists
          ? current.map((item) => item._id === updated._id
            ? updated
            : updated.isDefault
              ? { ...item, isDefault: false }
              : updated.role === "title"
                ? { ...item, role: item.role === "title" ? "chat" : item.role }
                : item)
          : [...current, updated];
      });
      setAgent(agentDraft(updated, agent.selectedProviderId));
      toast.success(t("Agent 已保存"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("保存 Agent 失败"));
    } finally {
      setSaving(false);
    }
  }

  async function fetchProviderModels() {
    if (!provider || provider.id === BUILTIN_PROVIDER_ID) return;
    if (!provider.baseUrl.trim()) {
      toast.error(t("请先填写 Base URL。"));
      return;
    }
    probeController.current?.abort();
    const controller = new AbortController();
    probeController.current = controller;
    setProbingModels(true);
    const draft = provider;
    try {
      const response = await fetch("/api/providers/probe", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), apiFormat: draft.apiFormat }),
      });
      if (response.status === 401) { router.replace("/login"); return; }
      if (!response.ok) throw new Error(await readError(response, t("拉取模型列表失败，请检查地址和密钥。")));
      const payload = await response.json() as { models: ModelEmbed[] };
      if (controller.signal.aborted) return;
      setProvider((current) => current && current.id === draft.id && current.baseUrl === draft.baseUrl && current.apiKey === draft.apiKey && current.apiFormat === draft.apiFormat
        ? { ...current, models: mergeProviderModels(current.models, payload.models) } : current);
      toast.success(t("已拉取 {0} 个模型，保存 Provider 后生效。", { "0": payload.models.length }));
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : t("拉取模型列表失败，请检查地址和密钥。"));
    } finally {
      if (probeController.current === controller) setProbingModels(false);
    }
  }

  async function saveProvider() {
    if (!provider || provider.id === BUILTIN_PROVIDER_ID) return;
    if (!provider.name.trim() || !provider.baseUrl.trim() || !provider.apiKey.trim() || provider.models.some((model) => !model.modelId.trim())) {
      toast.error(t("请填写 Provider 名称、地址和 API Key。"));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...provider, name: provider.name.trim(), baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey.trim(), updatedAt: now() }),
      });
      if (!response.ok) throw new Error(await readError(response, t("保存 Provider 失败")));
      const previous = providers.find((item) => item._id === provider.id);
      const updated: ProviderDoc = { ...provider, _id: provider.id, name: provider.name.trim(), baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey.trim(), updatedAt: now(), version: previous?.version ?? 0, deleted: false, userId: previous?.userId ?? "" };
      setProviders((current) => current.some((item) => item._id === updated._id) ? current.map((item) => item._id === updated._id ? updated : item) : [...current, updated]);
      setProvider(providerDraft(updated));
      toast.success(t("Provider 已保存"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("保存 Provider 失败"));
    } finally {
      setSaving(false);
    }
  }

  async function saveProject() {
    if (!project) return;
    if (!project.name.trim()) {
      toast.error(t("请输入项目名称。"));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...project, name: project.name.trim(), workspace: project.workspace.trim(), updatedAt: now() }),
      });
      if (!response.ok) throw new Error(await readError(response, t("保存项目失败")));
      const updated: ProjectDoc = { ...project, _id: project.id, name: project.name.trim(), workspace: project.workspace.trim(), updatedAt: now(), version: 0, deleted: false, userId: "" };
      setProjects((current) => current.some((item) => item._id === updated._id) ? current.map((item) => item._id === updated._id ? updated : item) : [...current, updated]);
      setProject(projectDraft(updated));
      toast.success(t("项目已保存"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("保存项目失败"));
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrent() {
    const current = tab === "agents" ? agent : tab === "providers" ? provider : project;
    if (!current || (tab === "providers" && current.id === BUILTIN_PROVIDER_ID)) return;
    const resource = tab === "agents" ? "agents" : tab === "providers" ? "providers" : "projects";
    try {
      const response = await fetch(`/api/${resource}/${current.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response, t("删除失败")));
      if (tab === "agents") {
        const next = agents.filter((item) => item._id !== current.id);
        setAgents(next);
        setAgent(next[0] ? agentDraft(next[0]) : newAgent(t));
      } else if (tab === "providers") {
        const next = providers.filter((item) => item._id !== current.id);
        setProviders(next);
        setProvider(next[0] ? providerDraft(next[0]) : providerDraft(builtinProvider));
      } else {
        const next = projects.filter((item) => item._id !== current.id);
        setProjects(next);
        setProject(next[0] ? projectDraft(next[0]) : newProject(t));
      }
      toast.success(t("已删除"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("删除失败"));
    }
  }

  const tabMeta = {
    agents: { label: "Agents", description: t("定义不同的角色、系统提示词和默认模型。"), icon: Bot },
    providers: { label: "Providers", description: t("管理 API 地址、密钥和可用模型。"), icon: Server },
    projects: { label: "Projects", description: t("为工作流保留共享的项目工作区。"), icon: FolderKanban },
  }[tab];
  const viewingBuiltinProvider = tab === "providers" && provider?.id === BUILTIN_PROVIDER_ID;
  const isNew = !activeItems.some((item) => item._id === (tab === "agents" ? agent?.id : tab === "providers" ? provider?.id : project?.id));

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[9rem_minmax(0,1fr)] gap-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-5">
      <aside className="flex min-h-0 min-w-0 flex-col gap-3 border-r pr-3 sm:pr-5" aria-label={t("配置导航")}>
        <Tabs value={tab} onValueChange={(value) => { setTab(value as Tab); setQuery(""); }} orientation="vertical">
          <TabsList className="h-auto w-full flex-col items-stretch">
            {(["agents", "providers", "projects"] as const).map((item) => {
              const meta = {
                agents: { label: "Agents", icon: Bot, count: agents.length },
                providers: { label: "Providers", icon: Server, count: allProviders.length },
                projects: { label: "Projects", icon: FolderKanban, count: projects.length },
              }[item];
              const Icon = meta.icon;
              return (
                <TabsTrigger key={item} value={item} className="w-full justify-start">
                  <Icon /> {meta.label}
                  <Badge variant="secondary" className="ml-auto px-1.5 tabular-nums">{meta.count}</Badge>
                </TabsTrigger>
              );
            })}
          </TabsList>
        </Tabs>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("筛选...")} aria-label={t("筛选配置")} className="h-9" />
        <ScrollArea type="always" className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="grid gap-1 pr-3">
            {visibleItems.length === 0 ? <p className="p-2 text-xs text-muted-foreground">{query ? t("没有匹配的配置") : t("暂无配置，请在右侧新建。")}</p> : null}
            {visibleItems.map((item) => {
              const active = (tab === "agents" ? agent?.id : tab === "providers" ? provider?.id : project?.id) === item._id;
              return (
                <Button key={item._id} variant={active ? "secondary" : "ghost"} aria-pressed={active} className="h-auto min-w-0 justify-start px-2 py-3" onClick={() => selectItem(item)}>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{item.name}</span>
                    <span className="mt-1 block truncate text-xs font-normal text-muted-foreground">{tab === "providers" ? item._id === BUILTIN_PROVIDER_ID ? t("内置云服务 · {0} 个模型", { "0": builtinProvider.models.length }) : (item as ProviderDoc).baseUrl : tab === "projects" ? (item as ProjectDoc).workspace || t("未设置工作区") : (item as AgentDoc).defaultModelId || t("未设置模型")}</span>
                  </span>
                  <ChevronRight className="size-4 shrink-0" />
                </Button>
              );
            })}
          </div>
        </ScrollArea>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col gap-4" aria-label={t("配置编辑")}>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight">{viewingBuiltinProvider ? t("查看") : isNew ? t("新增") : t("编辑")} {tabMeta.label.slice(0, -1)}</h2>
            <p className="text-xs text-muted-foreground">{tabMeta.description}</p>
          </div>
          <Button onClick={addItem} size="sm"><Plus /> {" "}{t("新建")}</Button>
        </div>
        <ScrollArea type="always" className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="min-w-0 space-y-4 pr-3 pb-2">
          {tab === "agents" && agent ? (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2">{isNew ? t("新增") : t("编辑")} Agent {agent.role === "default" ? <Badge><Check className="size-3" /> {" "}{t("默认")}</Badge> : null} {agent.role === "title" ? <Badge variant="secondary"><WandSparkles className="size-3" /> {" "}{t("标题生成")}</Badge> : null}</CardTitle><CardDescription>{t("保存后会通过同步服务分发到其他设备。")}</CardDescription></CardHeader>
              <CardContent className="grid gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2"><Label>{t("名称")}</Label><Input value={agent.name} disabled={agent.role === "default"} onChange={(event) => setAgent({ ...agent, name: event.target.value })} /></div>
                  <div className="grid gap-2"><Label>{t("角色")}</Label><Select value={agent.role} disabled={agent.role === "default"} onValueChange={(value) => setAgent({ ...agent, role: value as AgentDraft["role"] })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">{t("默认 Agent")}</SelectItem><SelectItem value="chat">{t("聊天 Agent")}</SelectItem><SelectItem value="title">{t("标题生成 Agent")}</SelectItem></SelectContent></Select></div>
                </div>
                <div className="grid gap-2"><Label>{t("描述")}</Label><Input value={agent.description} onChange={(event) => setAgent({ ...agent, description: event.target.value })} placeholder={t("可选")} /></div>
                <div className="grid gap-2"><Label>System prompt</Label>{canFollowDefaults ? <FollowToggle id="agent-followDefaultSystemPrompt" label={t("跟随默认")} checked={agent.followDefaultSystemPrompt} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultSystemPrompt: checked })} /> : null}<Textarea value={agent.systemPrompt} disabled={agent.followDefaultSystemPrompt && canFollowDefaults} onChange={(event) => setAgent({ ...agent, systemPrompt: event.target.value })} className="min-h-32" /></div>
                <div className="grid gap-3 rounded-lg border p-3">
                  <Label>{t("模型")}</Label>
                  {canFollowDefaults ? <FollowToggle id="agent-followDefaultModel" label={t("跟随默认")} checked={agent.followDefaultModel} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultModel: checked })} /> : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="grid gap-2">
                      <Label htmlFor="agent-provider">Provider</Label>
                      <Select value={agent.selectedProviderId} disabled={agent.followDefaultModel && canFollowDefaults} onValueChange={(value) => setAgent({ ...agent, selectedProviderId: value, defaultModelId: "" })}>
                        <SelectTrigger id="agent-provider" className="w-full"><SelectValue placeholder={t("选择 Provider")} /></SelectTrigger>
                        <SelectContent>{allProviders.map((item) => <SelectItem key={item._id} value={item._id}>{item.name}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="agent-model">{t("模型")}</Label>
                      <Select value={agent.defaultModelId} disabled={agent.followDefaultModel && canFollowDefaults} onValueChange={(value) => setAgent({ ...agent, defaultModelId: value })}>
                        <SelectTrigger id="agent-model" className="w-full"><SelectValue placeholder={selectedAgentModels.length ? t("选择模型") : t("该 Provider 暂无模型")} /></SelectTrigger>
                        <SelectContent>{selectedAgentModels.map((model) => <SelectItem key={model.modelId} value={model.modelId}>{model.displayName || model.modelId}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{selectedAgentProvider?.name ?? t("先选择 Provider")} · {agent.defaultModelId || t("未选择模型")}</p>
                  <ModelMetadataSummary state={modelMetadata} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2"><Label htmlFor="agent-temperature">Temperature</Label>{canFollowDefaults ? <FollowToggle id="agent-followDefaultTemperature" label={t("跟随默认")} checked={agent.followDefaultTemperature} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultTemperature: checked })} /> : null}<Input id="agent-temperature" type="number" min="0" max="2" step="0.1" placeholder={t("留空不发送")} value={agent.temperature} disabled={(agent.followDefaultTemperature && canFollowDefaults) || modelCapabilities?.supportsTemperature === false} onChange={(event) => setAgent({ ...agent, temperature: event.target.value })} /></div>
                  <div className="grid gap-2"><Label htmlFor="agent-topP">Top P</Label>{canFollowDefaults ? <FollowToggle id="agent-followDefaultTopP" label={t("跟随默认")} checked={agent.followDefaultTopP} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultTopP: checked })} /> : null}<Input id="agent-topP" type="number" min="0" max="1" step="0.05" placeholder={t("留空不发送")} value={agent.topP} disabled={(agent.followDefaultTopP && canFollowDefaults) || modelCapabilities?.supportsTopP === false} onChange={(event) => setAgent({ ...agent, topP: event.target.value })} /></div>
                  {([
                    { key: "frequencyPenalty", follow: "followDefaultFrequencyPenalty", label: "Frequency penalty" },
                    { key: "presencePenalty", follow: "followDefaultPresencePenalty", label: "Presence penalty" },
                  ] as const).map((field) => (
                    <div key={field.key} className="grid gap-2">
                      <Label htmlFor={`agent-${field.key}`}>{t(field.label)}</Label>
                      {canFollowDefaults ? <FollowToggle id={`agent-${field.follow}`} label={t("跟随默认")} checked={agent[field.follow]} onCheckedChange={(checked) => setAgent({ ...agent, [field.follow]: checked })} /> : null}
                      <Input id={`agent-${field.key}`} type="number" min="-2" max="2" step="0.1" value={agent[field.key]} disabled={(agent[field.follow] && canFollowDefaults) || modelCapabilities?.supportsPenalties === false} onChange={(event) => setAgent({ ...agent, [field.key]: event.target.value })} placeholder={t("留空不发送")} />
                    </div>
                  ))}
                  <div className="grid gap-2"><Label htmlFor="agent-maxTokens">Max tokens</Label>{canFollowDefaults ? <FollowToggle id="agent-followDefaultMaxTokens" label={t("跟随默认")} checked={agent.followDefaultMaxTokens} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultMaxTokens: checked })} /> : null}<Input id="agent-maxTokens" type="number" value={agent.maxTokens} disabled={agent.followDefaultMaxTokens && canFollowDefaults} onChange={(event) => setAgent({ ...agent, maxTokens: event.target.value })} placeholder={t("自动")} /></div>
                  <div className="grid gap-2"><Label htmlFor="agent-reasoningEffort">Reasoning effort</Label>{canFollowDefaults ? <FollowToggle id="agent-followDefaultReasoningEffort" label={t("跟随默认")} checked={agent.followDefaultReasoningEffort} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultReasoningEffort: checked })} /> : null}<ReasoningEffortSelect id="agent-reasoningEffort" metadata={modelCapabilities} value={canFollowDefaults && agent.followDefaultReasoningEffort ? defaultAgent?.reasoningEffort ?? "" : agent.reasoningEffort} disabled={saving || (agent.followDefaultReasoningEffort && canFollowDefaults)} onChange={(value) => setAgent({ ...agent, reasoningEffort: value })} /></div>
                </div>
                <p className="text-xs text-muted-foreground">{t("默认 Agent 作为角色单独存在；当前默认 Agent 不能直接取消，请在其他 Agent 上选择“默认 Agent”完成转移。")}</p>
                <div className="flex flex-wrap justify-between gap-2"><DeleteButton onConfirm={() => void removeCurrent()} /><Button onClick={() => void saveAgent()} disabled={saving}><Save /> {saving ? t("保存中...") : t("保存 Agent")}</Button></div>
              </CardContent>
            </Card>
          ) : null}

          {viewingBuiltinProvider ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">{builtinProvider.name}<Badge variant="secondary">{t("内置")}</Badge></CardTitle>
                <CardDescription>{t("通过 Messenger Cloud 提供模型，无需配置地址和 API Key。模型由平台管理，可在 Agent 的模型设置中选择。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <Label>{t("可用模型（")}{builtinProvider.models.length}）</Label>
                <ProviderModelsTable models={builtinProvider.models} readOnly />
              </CardContent>
            </Card>
          ) : null}

          {tab === "providers" && provider && !viewingBuiltinProvider ? (
            <Card>
              <CardHeader><CardTitle>{isNew ? t("新增") : t("编辑")} Provider</CardTitle><CardDescription>{t("API Key 仅用于同步和 AI 请求，不会展示给其他用户。")}</CardDescription></CardHeader>
              <CardContent className="grid gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2"><Label>{t("名称")}</Label><Input value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} /></div>
                  <div className="grid gap-2"><Label>{t("协议")}</Label><Select value={provider.apiFormat} onValueChange={(value) => setProvider({ ...provider, apiFormat: value as ProviderDraft["apiFormat"] })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{(["chat", "responses", "messages", "interactions", "auto"] as const).map((format) => <SelectItem key={format} value={format}>{format}</SelectItem>)}</SelectContent></Select></div>
                </div>
                <div className="grid gap-2"><Label>Base URL</Label><Input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
                <div className="grid gap-2"><Label>API Key</Label><Input type="password" value={provider.apiKey} onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })} /></div>
                <ProviderModelsTable key={provider.id} models={provider.models} disabled={saving} fetching={probingModels} onFetch={() => void fetchProviderModels()} onChange={(models) => setProvider((current) => current && current.id === provider.id ? { ...current, models } : current)} />
                <div className="flex flex-wrap justify-between gap-2"><DeleteButton onConfirm={() => void removeCurrent()} /><Button onClick={() => void saveProvider()} disabled={saving || probingModels}><Save /> {saving ? t("保存中...") : t("保存 Provider")}</Button></div>
              </CardContent>
            </Card>
          ) : null}

          {tab === "projects" && project ? (
            <Card>
              <CardHeader><CardTitle>{isNew ? t("新增") : t("编辑")} Project</CardTitle><CardDescription>{t("项目会与会话一起同步，方便在不同设备继续工作。")}</CardDescription></CardHeader>
              <CardContent className="grid gap-5">
                <div className="grid gap-2"><Label>{t("名称")}</Label><Input value={project.name} onChange={(event) => setProject({ ...project, name: event.target.value })} /></div>
                <div className="grid gap-2"><Label>{t("工作区路径")}</Label><Input value={project.workspace} onChange={(event) => setProject({ ...project, workspace: event.target.value })} placeholder={t("可选，例如 /workspace/my-project")} /></div>
                <div className="flex flex-wrap justify-between gap-2"><DeleteButton onConfirm={() => void removeCurrent()} /><Button onClick={() => void saveProject()} disabled={saving}><Save /> {saving ? t("保存中...") : t("保存 Project")}</Button></div>
              </CardContent>
            </Card>
          ) : null}
          </div>
        </ScrollArea>
      </section>
    </div>
  );
}
