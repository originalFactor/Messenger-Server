"use client";

/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { useMemo, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { AgentDoc, ModelEmbed, ProjectDoc, ProviderDoc } from "@/lib/types";
import type { PlazaModel } from "@/lib/model-plaza";

type Props = {
  initialAgents: AgentDoc[];
  initialProviders: ProviderDoc[];
  initialProjects: ProjectDoc[];
  builtinModels: PlazaModel[];
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
  maxTokens: string;
  reasoningEffort: string;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
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

function newAgent(): AgentDraft {
  return {
    id: crypto.randomUUID(),
    name: "新 Agent",
    systemPrompt: "You are a helpful assistant.",
    description: "",
    role: "chat",
    selectedProviderId: "",
    defaultModelId: "",
    temperature: "0.7",
    topP: "1",
    maxTokens: "",
    reasoningEffort: "",
    isDefault: false,
    followDefaultSystemPrompt: false,
    followDefaultModel: false,
    followDefaultTemperature: false,
    followDefaultTopP: false,
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
    temperature: String(agent.temperature),
    topP: String(agent.topP),
    maxTokens: agent.maxTokens == null ? "" : String(agent.maxTokens),
    reasoningEffort: agent.reasoningEffort ?? "",
    isDefault: agent.isDefault,
    followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
    followDefaultModel: agent.followDefaultModel,
    followDefaultTemperature: agent.followDefaultTemperature,
    followDefaultTopP: agent.followDefaultTopP,
    followDefaultMaxTokens: agent.followDefaultMaxTokens,
    followDefaultReasoningEffort: agent.followDefaultReasoningEffort,
    createdAt: agent.createdAt,
  };
}

function newProvider(): ProviderDraft {
  return {
    id: crypto.randomUUID(),
    name: "新 Provider",
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

function newProject(): ProjectDraft {
  return { id: crypto.randomUUID(), name: "新项目", workspace: "", createdAt: now() };
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
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive"><Trash2 /> 删除</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>确定删除这个配置吗？</AlertDialogTitle>
          <AlertDialogDescription>删除会同步到你的所有设备。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>删除</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ConsoleManagement({ initialAgents, initialProviders, initialProjects, builtinModels }: Props) {
  const [tab, setTab] = useState<Tab>("agents");
  const [agents, setAgents] = useState(initialAgents);
  const [providers, setProviders] = useState(initialProviders);
  const [projects, setProjects] = useState(initialProjects);
  const builtinProvider = useMemo<ProviderDoc>(() => ({
    _id: BUILTIN_PROVIDER_ID,
    userId: "",
    name: "Messenger Cloud AI（内置）",
    baseUrl: "",
    apiKey: "",
    apiFormat: "chat",
    models: builtinModels.map((model) => ({
      id: `builtin:${model.modelId}`,
      modelId: model.modelId,
      displayName: model.modelId,
      isEnabled: true,
      contextWindow: null,
      inputRate: model.inputRateMin,
      outputRate: model.outputRateMin,
      createdAt: 0,
    })),
    createdAt: 0,
    updatedAt: 0,
    version: 0,
    deleted: false,
  }), [builtinModels]);
  const initialAllProviders = [builtinProvider, ...initialProviders];
  const providerForModel = (modelId: string | null | undefined) =>
    initialAllProviders.find((item) => item.models.some((model) => model.modelId === modelId))?._id ?? "";
  const [agent, setAgent] = useState<AgentDraft | null>(() => initialAgents[0] ? agentDraft(initialAgents[0], providerForModel(initialAgents[0].defaultModelId)) : newAgent());
  const [provider, setProvider] = useState<ProviderDraft | null>(() => initialProviders[0] ? providerDraft(initialProviders[0]) : newProvider());
  const [project, setProject] = useState<ProjectDraft | null>(() => initialProjects[0] ? projectDraft(initialProjects[0]) : newProject());
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");

  const allProviders = useMemo(() => [builtinProvider, ...providers], [builtinProvider, providers]);
  const modelIds = useMemo(() => allProviders.flatMap((item) => item.models.filter((model) => model.isEnabled).map((model) => model.modelId)), [allProviders]);
  const selectedAgentProvider = allProviders.find((item) => item._id === agent?.selectedProviderId);
  const selectedAgentModels = selectedAgentProvider?.models.filter((model) => model.isEnabled) ?? [];
  const canFollowDefaults = agent?.role !== "default";

  const activeItems = tab === "agents" ? agents : tab === "providers" ? providers : projects;
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
    if (tab === "agents") setAgent(newAgent());
    if (tab === "providers") setProvider(newProvider());
    if (tab === "projects") setProject(newProject());
  }

  async function saveAgent() {
    if (!agent) return;
    const temperature = Number(agent.temperature);
    const topP = Number(agent.topP);
    const maxTokens = agent.maxTokens ? Number(agent.maxTokens) : null;
    if (!agent.name.trim() || !agent.systemPrompt.trim() || !Number.isFinite(temperature) || !Number.isFinite(topP)) {
      toast.error("请填写有效的 Agent 名称、提示词和采样参数。");
      return;
    }
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
          maxTokens: maxTokens == null || Number.isNaN(maxTokens) ? null : maxTokens,
          reasoningEffort: agent.reasoningEffort.trim() || null,
          isDefault: agent.role === "default",
          followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
          followDefaultModel: agent.followDefaultModel,
          followDefaultTemperature: agent.followDefaultTemperature,
          followDefaultTopP: agent.followDefaultTopP,
          followDefaultMaxTokens: agent.followDefaultMaxTokens,
          followDefaultReasoningEffort: agent.followDefaultReasoningEffort,
          role: agent.role === "title" ? "title" : "chat",
          toolsEnabled: false,
          toolsFollowDefault: false,
          toolsConfig: null,
          createdAt: agent.createdAt,
          updatedAt: now(),
        }),
      });
      if (!response.ok) throw new Error(await readError(response, "保存 Agent 失败"));
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
        maxTokens,
        reasoningEffort: agent.reasoningEffort.trim() || null,
        isDefault: agent.role === "default",
        role: agent.role === "default" ? null : agent.role,
        followDefaultSystemPrompt: agent.followDefaultSystemPrompt,
        followDefaultModel: agent.followDefaultModel,
        followDefaultTemperature: agent.followDefaultTemperature,
        followDefaultTopP: agent.followDefaultTopP,
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
      toast.success("Agent 已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Agent 失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveProvider() {
    if (!provider) return;
    if (!provider.name.trim() || !provider.baseUrl.trim() || !provider.apiKey.trim() || provider.models.some((model) => !model.modelId.trim())) {
      toast.error("请填写 Provider 名称、地址和 API Key。");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/providers/${provider.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...provider, name: provider.name.trim(), baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey.trim(), updatedAt: now() }),
      });
      if (!response.ok) throw new Error(await readError(response, "保存 Provider 失败"));
      const previous = providers.find((item) => item._id === provider.id);
      const updated: ProviderDoc = { ...provider, _id: provider.id, name: provider.name.trim(), baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey.trim(), updatedAt: now(), version: previous?.version ?? 0, deleted: false, userId: previous?.userId ?? "" };
      setProviders((current) => current.some((item) => item._id === updated._id) ? current.map((item) => item._id === updated._id ? updated : item) : [...current, updated]);
      setProvider(providerDraft(updated));
      toast.success("Provider 已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Provider 失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveProject() {
    if (!project) return;
    if (!project.name.trim()) {
      toast.error("请输入项目名称。");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...project, name: project.name.trim(), workspace: project.workspace.trim(), updatedAt: now() }),
      });
      if (!response.ok) throw new Error(await readError(response, "保存项目失败"));
      const updated: ProjectDoc = { ...project, _id: project.id, name: project.name.trim(), workspace: project.workspace.trim(), updatedAt: now(), version: 0, deleted: false, userId: "" };
      setProjects((current) => current.some((item) => item._id === updated._id) ? current.map((item) => item._id === updated._id ? updated : item) : [...current, updated]);
      setProject(projectDraft(updated));
      toast.success("项目已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存项目失败");
    } finally {
      setSaving(false);
    }
  }

  async function removeCurrent() {
    const current = tab === "agents" ? agent : tab === "providers" ? provider : project;
    if (!current) return;
    const resource = tab === "agents" ? "agents" : tab === "providers" ? "providers" : "projects";
    try {
      const response = await fetch(`/api/${resource}/${current.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await readError(response, "删除失败"));
      if (tab === "agents") {
        const next = agents.filter((item) => item._id !== current.id);
        setAgents(next);
        setAgent(next[0] ? agentDraft(next[0]) : newAgent());
      } else if (tab === "providers") {
        const next = providers.filter((item) => item._id !== current.id);
        setProviders(next);
        setProvider(next[0] ? providerDraft(next[0]) : newProvider());
      } else {
        const next = projects.filter((item) => item._id !== current.id);
        setProjects(next);
        setProject(next[0] ? projectDraft(next[0]) : newProject());
      }
      toast.success("已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }

  const tabMeta = {
    agents: { label: "Agents", description: "定义不同的角色、系统提示词和默认模型。", icon: Bot },
    providers: { label: "Providers", description: "管理 API 地址、密钥和可用模型。", icon: Server },
    projects: { label: "Projects", description: "为工作流保留共享的项目工作区。", icon: FolderKanban },
  }[tab];
  const TabIcon = tabMeta.icon;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="text-xl font-semibold tracking-tight">配置管理</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">直接在 Web 配置同步到手机、桌面端和 Web Messenger 的 Agents、Providers 与 Projects。</p>
        </div>
        <Button onClick={addItem}><Plus /> 新建{tabMeta.label.slice(0, -1)}</Button>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList>
          {(["agents", "providers", "projects"] as const).map((item) => {
            const meta = {
              agents: { label: "Agents", icon: Bot, count: agents.length },
              providers: { label: "Providers", icon: Server, count: providers.length },
              projects: { label: "Projects", icon: FolderKanban, count: projects.length },
            }[item];
            const Icon = meta.icon;
            return (
              <TabsTrigger key={item} value={item}>
                <Icon />
                {meta.label}
                <Badge variant="secondary" className="px-1.5 tabular-nums">{meta.count}</Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      <div className="grid gap-6">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <div className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground"><TabIcon className="size-5" /></div>
                <div><CardTitle>{tabMeta.label}</CardTitle><CardDescription>{tabMeta.description}</CardDescription></div>
              </div>
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选..." className="h-9 sm:w-48" />
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {visibleItems.length === 0 ? <button type="button" onClick={addItem} className="rounded-lg border border-dashed p-5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50">还没有配置，点击新建 →</button> : null}
              {visibleItems.map((item) => {
                const id = item._id;
                const active = (tab === "agents" ? agent?.id : tab === "providers" ? provider?.id : project?.id) === id;
                return (
                  <button key={id} type="button" onClick={() => selectItem(item)} className={`group rounded-lg border p-4 text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${active ? "border-primary bg-muted" : "bg-card hover:bg-muted/50"}`}>
                    <div className="flex items-start gap-3">
                      <div className={`grid size-9 place-items-center rounded-lg ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                        {tab === "agents" ? <Bot className="size-4" /> : tab === "providers" ? <Server className="size-4" /> : <FolderKanban className="size-4" />}
                      </div>
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{tab === "providers" ? (item as ProviderDoc).baseUrl : tab === "projects" ? (item as ProjectDoc).workspace || "未设置工作区" : (item as AgentDoc).defaultModelId || "未设置模型"}</span></span>
                      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                    </div>
                  </button>
                );
              })}
            </CardContent>
          </Card>

          {tab === "agents" && agent ? (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2">编辑 Agent {agent.role === "default" ? <Badge><Check className="size-3" /> 默认</Badge> : null} {agent.role === "title" ? <Badge variant="secondary"><WandSparkles className="size-3" /> 标题生成</Badge> : null}</CardTitle><CardDescription>保存后会通过同步服务分发到其他设备。</CardDescription></CardHeader>
              <CardContent className="grid gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2"><Label>名称</Label><Input value={agent.name} disabled={agent.role === "default"} onChange={(event) => setAgent({ ...agent, name: event.target.value })} /></div>
                  <div className="grid gap-2"><Label>角色</Label><Select value={agent.role} disabled={agent.role === "default"} onValueChange={(value) => setAgent({ ...agent, role: value as AgentDraft["role"] })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">默认 Agent</SelectItem><SelectItem value="chat">聊天 Agent</SelectItem><SelectItem value="title">标题生成 Agent</SelectItem></SelectContent></Select></div>
                </div>
                <div className="grid gap-2"><Label>描述</Label><Input value={agent.description} onChange={(event) => setAgent({ ...agent, description: event.target.value })} placeholder="可选" /></div>
                <div className="grid gap-2"><Label>System prompt</Label>{canFollowDefaults ? <FollowToggle id="agent-followDefaultSystemPrompt" label="跟随默认 Agent" checked={agent.followDefaultSystemPrompt} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultSystemPrompt: checked })} /> : null}<Textarea value={agent.systemPrompt} disabled={agent.followDefaultSystemPrompt && canFollowDefaults} onChange={(event) => setAgent({ ...agent, systemPrompt: event.target.value })} className="min-h-32" /></div>
                <div className="grid gap-3 rounded-lg border p-3">{canFollowDefaults ? <FollowToggle id="agent-followDefaultModel" label="模型跟随默认 Agent" checked={agent.followDefaultModel} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultModel: checked })} /> : null}<div className="grid gap-4 sm:grid-cols-2"><Select value={agent.selectedProviderId} disabled={agent.followDefaultModel && canFollowDefaults} onValueChange={(value) => setAgent({ ...agent, selectedProviderId: value, defaultModelId: "" })}><SelectTrigger className="w-full"><SelectValue placeholder="选择 Provider" /></SelectTrigger><SelectContent>{allProviders.map((item) => <SelectItem key={item._id} value={item._id}>{item.name}</SelectItem>)}</SelectContent></Select><Select value={agent.defaultModelId} disabled={agent.followDefaultModel && canFollowDefaults} onValueChange={(value) => setAgent({ ...agent, defaultModelId: value })}><SelectTrigger className="w-full"><SelectValue placeholder={selectedAgentModels.length ? "选择模型" : "该 Provider 暂无模型"} /></SelectTrigger><SelectContent>{selectedAgentModels.map((model) => <SelectItem key={model.modelId} value={model.modelId}>{model.displayName || model.modelId}</SelectItem>)}</SelectContent></Select></div><p className="text-xs text-muted-foreground">{selectedAgentProvider?.name ?? "先选择 Provider"} · {agent.defaultModelId || "未选择模型"}</p></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">{canFollowDefaults ? <FollowToggle id="agent-followDefaultTemperature" label="Temperature 跟随默认" checked={agent.followDefaultTemperature} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultTemperature: checked })} /> : null}<Input type="number" step="0.1" value={agent.temperature} disabled={agent.followDefaultTemperature && canFollowDefaults} onChange={(event) => setAgent({ ...agent, temperature: event.target.value })} /></div>
                  <div className="grid gap-2">{canFollowDefaults ? <FollowToggle id="agent-followDefaultTopP" label="Top P 跟随默认" checked={agent.followDefaultTopP} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultTopP: checked })} /> : null}<Input type="number" step="0.05" value={agent.topP} disabled={agent.followDefaultTopP && canFollowDefaults} onChange={(event) => setAgent({ ...agent, topP: event.target.value })} /></div>
                  <div className="grid gap-2">{canFollowDefaults ? <FollowToggle id="agent-followDefaultMaxTokens" label="Max tokens 跟随默认" checked={agent.followDefaultMaxTokens} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultMaxTokens: checked })} /> : null}<Input type="number" value={agent.maxTokens} disabled={agent.followDefaultMaxTokens && canFollowDefaults} onChange={(event) => setAgent({ ...agent, maxTokens: event.target.value })} placeholder="自动" /></div>
                  <div className="grid gap-2">{canFollowDefaults ? <FollowToggle id="agent-followDefaultReasoningEffort" label="Reasoning 跟随默认" checked={agent.followDefaultReasoningEffort} onCheckedChange={(checked) => setAgent({ ...agent, followDefaultReasoningEffort: checked })} /> : null}<Input value={agent.reasoningEffort} disabled={agent.followDefaultReasoningEffort && canFollowDefaults} onChange={(event) => setAgent({ ...agent, reasoningEffort: event.target.value })} placeholder="default / low / high" /></div>
                </div>
                <p className="text-xs text-muted-foreground">默认 Agent 作为角色单独存在；当前默认 Agent 不能直接取消，请在其他 Agent 上选择“默认 Agent”完成转移。</p>
                <div className="flex flex-wrap justify-between gap-2"><DeleteButton onConfirm={() => void removeCurrent()} /><Button onClick={() => void saveAgent()} disabled={saving}><Save /> {saving ? "保存中..." : "保存 Agent"}</Button></div>
              </CardContent>
            </Card>
          ) : null}

          {tab === "providers" && provider ? (
            <Card>
              <CardHeader><CardTitle>编辑 Provider</CardTitle><CardDescription>API Key 仅用于同步和 AI 请求，不会展示给其他用户。</CardDescription></CardHeader>
              <CardContent className="grid gap-5">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2"><Label>名称</Label><Input value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} /></div>
                  <div className="grid gap-2"><Label>协议</Label><Select value={provider.apiFormat} onValueChange={(value) => setProvider({ ...provider, apiFormat: value as ProviderDraft["apiFormat"] })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{(["chat", "responses", "messages", "interactions", "auto"] as const).map((format) => <SelectItem key={format} value={format}>{format}</SelectItem>)}</SelectContent></Select></div>
                </div>
                <div className="grid gap-2"><Label>Base URL</Label><Input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></div>
                <div className="grid gap-2"><Label>API Key</Label><Input type="password" value={provider.apiKey} onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })} /></div>
                <div className="grid gap-3"><div className="flex items-center justify-between"><div><Label>模型</Label><p className="text-xs text-muted-foreground">只会把启用的模型提供给聊天选择器。</p></div><Button type="button" variant="outline" size="sm" onClick={() => setProvider({ ...provider, models: [...provider.models, { id: crypto.randomUUID(), modelId: "", displayName: "", isEnabled: true, contextWindow: null, inputRate: null, outputRate: null, createdAt: now() }] })}><Plus /> 添加模型</Button></div>
                  {provider.models.length === 0 ? <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">还没有模型，请至少添加一个模型。</div> : provider.models.map((model, index) => <div key={model.id} className="grid gap-2 rounded-lg border bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-center"><Input value={model.modelId} onChange={(event) => setProvider({ ...provider, models: provider.models.map((item, itemIndex) => itemIndex === index ? { ...item, modelId: event.target.value } : item) })} placeholder="模型 ID" /><Input value={model.displayName} onChange={(event) => setProvider({ ...provider, models: provider.models.map((item, itemIndex) => itemIndex === index ? { ...item, displayName: event.target.value } : item) })} placeholder="显示名称（可选）" /><label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch size="sm" checked={model.isEnabled} onCheckedChange={(checked) => setProvider({ ...provider, models: provider.models.map((item, itemIndex) => itemIndex === index ? { ...item, isEnabled: checked } : item) })} />启用</label><Button type="button" variant="ghost" size="icon" onClick={() => setProvider({ ...provider, models: provider.models.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 className="size-4" /></Button></div>)}
                </div>
                <div className="flex flex-wrap justify-between gap-2"><DeleteButton onConfirm={() => void removeCurrent()} /><Button onClick={() => void saveProvider()} disabled={saving}><Save /> {saving ? "保存中..." : "保存 Provider"}</Button></div>
              </CardContent>
            </Card>
          ) : null}

          {tab === "projects" && project ? (
            <Card>
              <CardHeader><CardTitle>编辑 Project</CardTitle><CardDescription>项目会与会话一起同步，方便在不同设备继续工作。</CardDescription></CardHeader>
              <CardContent className="grid gap-5">
                <div className="grid gap-2"><Label>名称</Label><Input value={project.name} onChange={(event) => setProject({ ...project, name: event.target.value })} /></div>
                <div className="grid gap-2"><Label>工作区路径</Label><Input value={project.workspace} onChange={(event) => setProject({ ...project, workspace: event.target.value })} placeholder="可选，例如 /workspace/my-project" /></div>
                <div className="flex flex-wrap justify-between gap-2"><DeleteButton onConfirm={() => void removeCurrent()} /><Button onClick={() => void saveProject()} disabled={saving}><Save /> {saving ? "保存中..." : "保存 Project"}</Button></div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
