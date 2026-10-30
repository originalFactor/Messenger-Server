"use client";

/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeft,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import katex from "katex";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/console/user-avatar";
import type { AgentDoc, ConversationDoc, MessageEmbed, ProviderDoc } from "@/lib/types";

type Props = {
  initialAgents: AgentDoc[];
  initialConversations: ConversationDoc[];
  initialProviders: ProviderDoc[];
  userName: string;
  userAvatarUrl: string | null;
};

type ChatMessage = MessageEmbed & { status: "SENDING" | "SENT" | "ERROR" };

function makeMessage(role: ChatMessage["role"], content: string, status: ChatMessage["status"] = "SENT"): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
    status,
    partsJson: null,
    errorMessage: null,
  };
}

function currentTimestamp(): number {
  return Date.now();
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: true,
});

type StoredPart = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: string;
  output?: string;
  isError?: boolean;
};

type RenderMessage = MessageEmbed & { parts: StoredPart[] };

function parseParts(message: MessageEmbed): StoredPart[] {
  if (!message.partsJson) return [];
  try {
    const parsed = JSON.parse(message.partsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((part): part is StoredPart => Boolean(part && typeof part === "object")) : [];
  } catch {
    return [];
  }
}

function groupMessages(messages: MessageEmbed[]): RenderMessage[] {
  const groups: RenderMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const parts = parseParts(message);
    const previous = groups[groups.length - 1];
    if (previous && previous.role === message.role && (message.role === "assistant" || message.role === "tool")) {
      previous.content = [previous.content, message.content].filter((value) => value.trim()).join("\n\n");
      previous.parts.push(...parts);
      previous.status = message.status;
      previous.errorMessage = message.errorMessage ?? previous.errorMessage;
      previous.timestamp = message.timestamp;
      continue;
    }
    groups.push({ ...message, parts });
  }
  return groups;
}

function splitThinking(content: string): { thinking: string; answer: string } {
  let thinking = "";
  let answer = content;
  const closed = /<think>([\s\S]*?)<\/think>/gi;
  answer = answer.replace(closed, (_match, value: string) => {
    thinking += value;
    return "";
  });
  const openIndex = answer.toLowerCase().indexOf("<think>");
  if (openIndex >= 0) {
    thinking += answer.slice(openIndex + 7);
    answer = answer.slice(0, openIndex);
  }
  return { thinking: thinking.trim(), answer: answer.trim() };
}

function renderMarkdown(source: string): string {
  const math: string[] = [];
  const protect = (expression: string, display: boolean) => {
    const index = math.push(katex.renderToString(expression.trim(), {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    })) - 1;
    return `MATHPLACEHOLDER${index}ENDMATH`;
  };
  let text = source.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_match, dollars: string, brackets: string) => protect(dollars ?? brackets, true));
  text = text.replace(/(^|[^$])\$([^$\n]+)\$/g, (_match, prefix: string, expression: string) => `${prefix}${protect(expression, false)}`);
  const html = markdown.render(text);
  return html.replace(/MATHPLACEHOLDER(\d+)ENDMATH/g, (_match, index: string) => math[Number(index)] ?? "");
}

function MarkdownMessage({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function AgentAvatar({ agent }: { agent: AgentDoc | undefined }) {
  if (!agent) return <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground"><Bot className="size-4" /></div>;
  return <UserAvatar src={agent.avatarUrl ? `/api/avatars/agents/${agent._id}?v=${agent.avatarVersion ?? 0}` : null} name={agent.name} className="mt-1 size-8 rounded-xl bg-primary text-primary-foreground text-primary-foreground" />;
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export function MessengerApp({ initialAgents, initialConversations, initialProviders, userName, userAvatarUrl }: Props) {
  const [agents] = useState(initialAgents);
  const [providers] = useState(initialProviders);
  const [conversations, setConversations] = useState(initialConversations);
  const [selectedId, setSelectedId] = useState<string | null>(initialConversations[0]?._id ?? null);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
  const titleAgentSource = agents.find((item) => item.role === "title");
  const titleAgent = titleAgentSource && defaultAgent
    ? {
        ...titleAgentSource,
        systemPrompt: titleAgentSource.followDefaultSystemPrompt ? defaultAgent.systemPrompt : titleAgentSource.systemPrompt,
        defaultModelId: titleAgentSource.followDefaultModel ? defaultAgent.defaultModelId : titleAgentSource.defaultModelId,
        temperature: titleAgentSource.followDefaultTemperature ? defaultAgent.temperature : titleAgentSource.temperature,
        topP: titleAgentSource.followDefaultTopP ? defaultAgent.topP : titleAgentSource.topP,
        maxTokens: titleAgentSource.followDefaultMaxTokens ? defaultAgent.maxTokens : titleAgentSource.maxTokens,
        reasoningEffort: titleAgentSource.followDefaultReasoningEffort ? defaultAgent.reasoningEffort : titleAgentSource.reasoningEffort,
      }
    : titleAgentSource;
  const selected = conversations.find((conversation) => conversation._id === selectedId) ?? null;
  const agent = agents.find((item) => item._id === selected?.agentId) ?? defaultAgent;
  const provider = providers.find((item) => item._id === selected?.providerId) ?? providers[0];
  const availableModel = selected?.overrideModelId ?? agent?.defaultModelId ?? provider?.models.find((model) => model.isEnabled)?.modelId ?? null;
  const filteredConversations = useMemo(
    () =>
      conversations
        .filter((conversation) => conversation.title.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, search],
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [selected?.messages.length, isSending]);

  function updateConversation(next: ConversationDoc) {
    setConversations((current) => current.map((conversation) => (conversation._id === next._id ? next : conversation)));
  }

  async function saveConversation(conversation: ConversationDoc) {
    const payload = {
      id: conversation._id,
      title: conversation.title,
      agentId: conversation.agentId,
      providerId: conversation.providerId,
      overrideModelId: conversation.overrideModelId ?? null,
      overrideTemperature: conversation.overrideTemperature ?? null,
      overrideTopP: conversation.overrideTopP ?? null,
      overrideMaxTokens: conversation.overrideMaxTokens ?? null,
      overrideReasoningEffort: conversation.overrideReasoningEffort ?? null,
      overrideToolsEnabled: conversation.overrideToolsEnabled ?? null,
      overrideToolsConfig: conversation.overrideToolsConfig ?? null,
      writable: conversation.writable ?? true,
      projectId: conversation.projectId ?? null,
      reasoningFormat: conversation.reasoningFormat ?? null,
      contextSummary: conversation.contextSummary ?? null,
      contextSummaryUntil: conversation.contextSummaryUntil ?? 0,
      contextTokens: conversation.contextTokens ?? 0,
      contextTokensAt: conversation.contextTokensAt ?? 0,
      messages: conversation.messages,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
    const response = await fetch(`/api/conversations/${conversation._id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? "保存会话失败");
  }

  function startConversation() {
    if (!defaultAgent || !providers[0]) {
      toast.error("请先在手机端配置 Agent 和 Provider。");
      return;
    }
    const selectedProvider = providers.find((item) => item.models.some((model) => model.isEnabled && model.modelId === defaultAgent.defaultModelId))
      ?? providers.find((item) => item.models.some((model) => model.isEnabled))
      ?? providers[0];
    if (!selectedProvider) {
      toast.error("请先配置可用模型。");
      return;
    }
    const now = Date.now();
    const next: ConversationDoc = {
      _id: crypto.randomUUID(),
      userId: "",
      agentId: defaultAgent._id,
      title: "新对话",
      providerId: selectedProvider._id,
      overrideModelId: null,
      overrideTemperature: null,
      overrideTopP: null,
      overrideMaxTokens: null,
      overrideReasoningEffort: null,
      overrideToolsEnabled: null,
      overrideToolsConfig: null,
      writable: true,
      projectId: null,
      reasoningFormat: null,
      contextSummary: null,
      contextSummaryUntil: 0,
      contextTokens: 0,
      contextTokensAt: 0,
      messages: [],
      createdAt: now,
      updatedAt: now,
      version: 0,
      deleted: false,
    };
    setConversations((current) => [next, ...current]);
    setSelectedId(next._id);
    setDraft("");
    void saveConversation(next).catch((error: unknown) => {
      setConversations((current) => current.filter((conversation) => conversation._id !== next._id));
      toast.error(error instanceof Error ? error.message : "创建会话失败");
    });
  }

  async function deleteConversation(id: string) {
    const response = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (!response.ok) {
      toast.error((await response.json().catch(() => null))?.error ?? "删除会话失败");
      return;
    }
    setConversations((current) => current.filter((conversation) => conversation._id !== id));
    if (selectedId === id) setSelectedId(conversations.find((conversation) => conversation._id !== id)?._id ?? null);
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;
    if (!selected || !agent || !provider) {
      toast.error("请先创建一个对话。");
      return;
    }
    if (selected.writable === false) {
      toast.error("此会话为只读模式。");
      return;
    }
    if (!availableModel) {
      toast.error("请先在 Messenger 中为 Agent 设置默认模型。");
      return;
    }

    const userMessage = makeMessage("user", text);
    const pending = makeMessage("assistant", "", "SENDING");
    const next: ConversationDoc = {
      ...selected,
      title: selected.messages.length === 0 ? text.slice(0, 36) : selected.title,
      messages: [...selected.messages, userMessage, pending],
      updatedAt: currentTimestamp(),
    };
    updateConversation(next);
    setDraft("");
    setIsSending(true);

    try {
      await saveConversation({ ...next, messages: next.messages.slice(0, -1) });
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: availableModel,
          stream: true,
          messages: [...selected.messages, userMessage].map((message) => ({ role: message.role, content: message.content })),
          temperature: selected.overrideTemperature ?? agent.temperature,
          top_p: selected.overrideTopP ?? agent.topP,
          max_tokens: selected.overrideMaxTokens ?? agent.maxTokens ?? undefined,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: { message?: string } | string } | null;
        const detail = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
        throw new Error(detail || (await response.text()) || "AI 请求失败");
      }
      if (!response.body) throw new Error("AI 返回为空");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      const append = (chunk: string) => {
        answer += chunk;
        updateConversation({ ...next, messages: [...next.messages.slice(0, -1), { ...pending, content: answer, status: "SENDING" }], updatedAt: Date.now() });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }> };
            const choice = parsed.choices?.[0];
            append(messageText(choice?.delta?.content ?? choice?.message?.content));
          } catch {
            // Ignore keep-alive frames and malformed intermediary events.
          }
        }
      }
      const complete: ConversationDoc = {
        ...next,
        messages: [...next.messages.slice(0, -1), { ...pending, content: answer || "（模型未返回文本）", status: "SENT" }],
        updatedAt: currentTimestamp(),
      };
      updateConversation(complete);
      await saveConversation(complete);
      if (selected.messages.length === 0 && titleAgent?.defaultModelId && answer.trim()) {
        await generateConversationTitle(complete, text, answer, titleAgent);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 请求失败";
      const failed: ConversationDoc = {
        ...next,
        messages: [...next.messages.slice(0, -1), { ...pending, content: message, errorMessage: message, status: "ERROR" }],
        updatedAt: currentTimestamp(),
      };
      updateConversation(failed);
      await saveConversation(failed).catch(() => undefined);
      toast.error(message);
    } finally {
      setIsSending(false);
    }
  }

  async function generateConversationTitle(conversation: ConversationDoc, userText: string, assistantText: string, title: AgentDoc) {
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: title.defaultModelId,
          stream: false,
          temperature: title.temperature,
          top_p: title.topP,
          max_tokens: title.maxTokens ?? 32,
          messages: [
            { role: "system", content: title.systemPrompt || "Generate a concise conversation title." },
            { role: "user", content: `User: ${userText}\nAssistant: ${assistantText}\n\nReturn only a short title, no quotes.` },
          ],
        }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? "标题生成失败");
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const nextTitle = messageText(payload.choices?.[0]?.message?.content).replace(/^["'“”]+|["'“”]+$/g, "").trim().slice(0, 80);
      if (!nextTitle) return;
      const titled = { ...conversation, title: nextTitle, updatedAt: currentTimestamp() };
      updateConversation(titled);
      await saveConversation(titled);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "标题生成失败");
    }
  }

  if (!defaultAgent || providers.length === 0) {
    return (
      <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center rounded-3xl border border-dashed bg-card/70 p-8 text-center">
        <div className="max-w-md space-y-4">
          <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Sparkles className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">准备你的第一个 AI 对话</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Web Messenger 使用你在手机端同步的 Agent、Provider 和模型配置。请先在 Messenger 中完成配置，再回到这里开始聊天。
          </p>
          <Button asChild>
            <a href="/console/account">打开账号设置</a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 w-full overflow-hidden bg-[#0d1720] text-slate-100">
      <aside className={`${sidebarOpen ? "w-[280px]" : "w-0"} min-w-0 shrink-0 overflow-hidden border-r border-white/10 bg-[#111820] transition-[width] duration-300`}>
        <div className="flex h-full min-w-[280px] flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300">Messenger</p>
              <h1 className="mt-1 text-lg font-semibold tracking-tight">你的对话</h1>
            </div>
            <Button size="icon" variant="outline" className="border-white/15 bg-white/5 text-slate-100 hover:bg-white/10" onClick={startConversation} aria-label="新建对话"><MessageSquarePlus /></Button>
          </div>
          <div className="px-3 py-3"><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索对话..." className="h-9 border-white/10 bg-white/5 text-slate-100 placeholder:text-slate-500" /></div>
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
            {filteredConversations.length === 0 ? (
              <button type="button" onClick={startConversation} className="mx-2 mt-8 w-[calc(100%-1rem)] rounded-xl border border-dashed border-white/15 p-4 text-left text-sm text-slate-400 hover:bg-white/5">开始一个新对话 →</button>
            ) : filteredConversations.map((conversation) => {
              const active = conversation._id === selectedId;
              return <div key={conversation._id} className={`group mb-1 flex min-w-0 items-center gap-1 rounded-xl px-2 py-1 ${active ? "bg-cyan-400/10" : "hover:bg-white/5"}`}>
                <button type="button" onClick={() => setSelectedId(conversation._id)} className="min-w-0 flex-1 px-2 py-2.5 text-left"><p className={`truncate text-sm font-medium ${active ? "text-cyan-200" : "text-slate-200"}`}>{conversation.title || "新对话"}</p><p className="mt-1 text-xs text-slate-500">{relativeTime(conversation.updatedAt)}</p></button>
                <Button variant="ghost" size="icon" className="size-8 text-slate-500 opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={() => void deleteConversation(conversation._id)} aria-label="删除会话"><Trash2 className="size-3.5" /></Button>
              </div>;
            })}
          </div>
          <div className="border-t border-white/10 px-4 py-3 text-xs text-slate-500">{conversations.length} 个会话 · {providers.length} 个 Provider</div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_80%_0%,rgba(14,116,144,0.23),transparent_35%),#0d1720]">
        <header className="flex min-w-0 shrink-0 items-center justify-between border-b border-white/10 bg-[#0d1720]/90 px-3 py-3 backdrop-blur-xl sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" className="text-slate-300 hover:bg-white/10 hover:text-white" onClick={() => setSidebarOpen((open) => !open)} aria-label="切换会话栏"><PanelLeft /></Button>
            <AgentAvatar agent={agent} />
            <div className="min-w-0"><h2 className="truncate text-sm font-semibold text-white">{selected?.title ?? "Messenger"}</h2><p className="truncate text-xs text-slate-400">{agent?.name ?? "Agent"} · {availableModel ?? "未选择模型"}</p></div>
          </div>
          <Badge variant="outline" className="hidden gap-1.5 rounded-full border-emerald-400/30 bg-emerald-400/10 text-emerald-200 sm:flex"><Check className="size-3" /> 已同步</Badge>
        </header>

        {!selected ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6"><div className="max-w-sm text-center"><div className="mx-auto mb-4 grid size-16 place-items-center rounded-3xl bg-cyan-400/15 text-cyan-200"><Bot className="size-8" /></div><h2 className="text-xl font-semibold">选择一个对话</h2><p className="mt-2 text-sm leading-6 text-slate-400">从左侧打开历史对话，或者新建一个空白会话。</p><Button className="mt-5" onClick={startConversation}>新建对话</Button></div></div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-6 sm:px-8">
              <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6">
                {selected.messages.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center py-24 text-center"><div className="mb-5 grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-cyan-400 to-blue-600 text-white shadow-xl shadow-cyan-900/30"><Sparkles className="size-7" /></div><h3 className="text-2xl font-semibold tracking-tight">今天想一起完成什么？</h3><p className="mt-2 max-w-sm text-sm leading-6 text-slate-400">提问、写作、头脑风暴，或者把一个复杂问题拆成下一步。</p></div>
                ) : groupMessages(selected.messages).map((message) => {
                  const parts = message.parts;
                  const { thinking, answer } = splitThinking(message.content);
                  const isTool = message.role === "tool";
                  const toolParts = parts.filter((part) => part.type === "tool_call" || part.type === "tool_result");
                  const renderedToolParts = toolParts.length > 0
                    ? toolParts
                    : isTool
                      ? [{ type: "tool_result", name: "tool", output: message.content }]
                      : [];
                  const visibleText = isTool ? "" : answer || parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
                  const isUser = message.role === "user";
                  return <div key={message.id} className={`flex min-w-0 items-start gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                    {!isUser ? <AgentAvatar agent={agent} /> : null}
                    <div className={`min-w-0 max-w-[min(88%,48rem)] ${isUser ? "order-first" : ""}`}>
                      {thinking ? <details open={message.status === "SENDING"} className="mb-2 overflow-hidden rounded-xl border border-amber-300/20 bg-amber-200/5 text-xs text-amber-100"><summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 font-medium"><ChevronDown className="size-3" />思考过程</summary><div className="border-t border-amber-300/10 px-3 py-3 text-amber-100/75"><MarkdownMessage content={thinking} /></div></details> : null}
                      {renderedToolParts.map((part, index) => <div key={`${message.id}-tool-${index}`} className="mb-2 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-3 text-xs text-cyan-100"><div className="mb-2 flex items-center gap-2 font-medium"><Wrench className="size-3.5" />{part.type === "tool_call" ? `调用 ${part.name ?? "工具"}` : `工具结果 · ${part.name ?? "工具"}`}</div><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-2 font-mono text-[11px] text-cyan-50/80">{part.type === "tool_call" ? part.arguments ?? "" : part.output ?? ""}</pre></div>)}
                      {visibleText || message.status === "SENDING" ? <div className={`overflow-hidden rounded-2xl px-4 py-3 text-sm leading-7 shadow-sm ${isUser ? "rounded-br-md bg-cyan-500 text-white" : "rounded-bl-md border border-white/10 bg-[#18232d] text-slate-100"} ${message.status === "ERROR" ? "border-red-400/50 text-red-200" : ""}`}>{message.status === "SENDING" && !visibleText ? <LoaderCircle className="size-4 animate-spin" /> : isUser ? <div className="whitespace-pre-wrap break-words">{visibleText}</div> : <MarkdownMessage content={visibleText} />}{message.status === "ERROR" ? <p className="mt-2 text-xs opacity-80">发送失败 · 可重试</p> : null}</div> : null}
                    </div>
                    {isUser ? <UserAvatar src={userAvatarUrl} name={userName} className="mt-1 size-8 rounded-xl bg-cyan-500 text-white" /> : null}
                  </div>;
                })}
                <div ref={bottomRef} />
              </div>
            </div>
            <form onSubmit={sendMessage} className="min-w-0 shrink-0 border-t border-white/10 bg-[#0d1720]/90 px-3 pb-4 pt-3 backdrop-blur-xl sm:px-8 sm:pb-5">
              <div className="mx-auto w-full min-w-0 max-w-3xl rounded-2xl border border-white/10 bg-[#18232d] p-2 shadow-2xl shadow-black/20">
                <Textarea ref={textareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="给 Messenger 发消息...（Enter 发送，Shift + Enter 换行）" className="min-h-12 w-full resize-none border-0 bg-transparent px-3 py-2 text-slate-100 shadow-none focus-visible:ring-0" disabled={isSending} />
                <div className="flex min-w-0 items-center justify-between gap-3 px-2 pb-1"><p className="min-w-0 truncate text-[11px] text-slate-500">{availableModel ? `${availableModel} · 云端额度计费` : "请先选择模型"}</p><Button type="submit" size="sm" disabled={!draft.trim() || isSending || selected.writable === false} className="shrink-0 rounded-xl bg-cyan-500 text-white hover:bg-cyan-400">{isSending ? <LoaderCircle className="animate-spin" /> : <Send />}发送</Button></div>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
