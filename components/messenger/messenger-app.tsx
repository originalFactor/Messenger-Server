"use client";

/*
 * Copyright 2026 originalFactor
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeft,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import katex from "katex";
import { cn } from "cn";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
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
  type?: string | null;
  text?: string | null;
  callId?: string | null;
  name?: string | null;
  arguments?: string | null;
  output?: string | null;
  isError?: boolean | null;
};

type ToolEntry = {
  callId: string | null;
  name: string;
  arguments: string;
  /** null = the call has no result yet. */
  output: string | null;
  isError: boolean;
};

type AgentBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string; error?: boolean }
  | { kind: "tool"; tool: ToolEntry };

type AgentTurn = { id: string; role: "agent"; blocks: AgentBlock[]; sending: boolean };
type UserItem = { id: string; role: "user"; text: string };
type RenderItem = UserItem | AgentTurn;

function parseParts(message: MessageEmbed): StoredPart[] {
  if (!message.partsJson) return [];
  try {
    const parsed = JSON.parse(message.partsJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((part): part is StoredPart => Boolean(part && typeof part === "object")) : [];
  } catch {
    return [];
  }
}

function pushContent(blocks: AgentBlock[], content: string, error: boolean) {
  const { thinking, answer } = splitThinking(content);
  const last = blocks[blocks.length - 1];
  if (thinking) {
    if (last?.kind === "thinking") last.text = `${last.text}\n\n${thinking}`;
    else blocks.push({ kind: "thinking", text: thinking });
  }
  if (answer) {
    const tail = blocks[blocks.length - 1];
    if (!error && tail?.kind === "text" && !tail.error) tail.text = `${tail.text}\n\n${answer}`;
    else blocks.push({ kind: "text", text: answer, error });
  }
}

function attachResult(blocks: AgentBlock[], result: { callId: string | null; name: string; output: string; isError: boolean }) {
  const tools = blocks.flatMap((block) => (block.kind === "tool" ? [block.tool] : []));
  const target = result.callId
    ? tools.find((tool) => tool.callId === result.callId)
    : tools.find((tool) => tool.output === null);
  if (target) {
    target.output = result.output;
    target.isError = result.isError;
    return;
  }
  blocks.push({ kind: "tool", tool: { callId: result.callId, name: result.name, arguments: "", output: result.output, isError: result.isError } });
}

/**
 * Consecutive assistant/tool messages are one Agent turn: text and reasoning are merged, and every
 * tool call is paired with its result (by `callId`) into a single entry.
 */
function groupMessages(messages: MessageEmbed[]): RenderItem[] {
  const items: RenderItem[] = [];
  let turn: AgentTurn | null = null;
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      turn = null;
      items.push({ id: message.id, role: "user", text: message.content });
      continue;
    }
    if (!turn) {
      turn = { id: message.id, role: "agent", blocks: [], sending: false };
      items.push(turn);
    }
    turn.sending = message.status === "SENDING";
    const error = message.status === "ERROR";
    const parts = parseParts(message);
    const hasText = parts.some((part) => part.type === "text");
    const hasToolParts = parts.some((part) => part.type === "tool_call" || part.type === "tool_result");
    if (message.role === "tool" && !hasToolParts) {
      attachResult(turn.blocks, { callId: null, name: "tool", output: message.content, isError: false });
      continue;
    }
    if (!hasText && message.role !== "tool" && message.content.trim()) pushContent(turn.blocks, message.content, error);
    for (const part of parts) {
      if (part.type === "text") pushContent(turn.blocks, part.text ?? "", error);
      else if (part.type === "tool_call") {
        turn.blocks.push({
          kind: "tool",
          tool: { callId: part.callId ?? null, name: part.name ?? "tool", arguments: part.arguments ?? "", output: null, isError: false },
        });
      } else if (part.type === "tool_result") {
        attachResult(turn.blocks, { callId: part.callId ?? null, name: part.name ?? "tool", output: part.output ?? "", isError: part.isError === true });
      }
    }
  }
  return items;
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

function AgentAvatar({ agent, className }: { agent: AgentDoc | undefined; className?: string }) {
  if (!agent) {
    return (
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-foreground/10", className)}>
        <Bot className="size-4" />
      </span>
    );
  }
  return (
    <UserAvatar
      src={agent.avatarUrl ? `/api/avatars/agents/${agent._id}?v=${agent.avatarVersion ?? 0}` : null}
      name={agent.name}
      className={className}
    />
  );
}

function NewConversationMenu({
  agents,
  onSelect,
  align = "start",
  children,
}: {
  agents: AgentDoc[];
  onSelect: (agent: AgentDoc) => void;
  align?: "start" | "end";
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-64">
        <DropdownMenuLabel>选择 Agent</DropdownMenuLabel>
        {agents.map((item) => (
          <DropdownMenuItem key={item._id} onSelect={() => onSelect(item)}>
            <AgentAvatar agent={item} className="size-6 text-xs" />
            <span className="min-w-0 flex-1 truncate">{item.name}</span>
            {item.isDefault ? <Badge variant="outline">默认</Badge> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThinkingBlock({ content, streaming }: { content: string; streaming: boolean }) {
  return (
    <Collapsible defaultOpen={streaming} className="group/thinking w-full rounded-lg border bg-background text-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
        <Brain className="size-3.5" />
        思考过程
        <ChevronDown className="ml-auto size-3.5 transition-transform group-data-[state=open]/thinking:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t px-3 py-3 text-muted-foreground">
          <MarkdownMessage content={content} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function toolSummary(args: string): string {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (parsed && typeof parsed === "object") {
      const first = Object.values(parsed).find((value) => typeof value === "string");
      if (typeof first === "string") return first.replace(/\s+/g, " ").trim();
    }
  } catch {
    // Not JSON (or still streaming): fall through to the raw text.
  }
  return args.replace(/\s+/g, " ").trim();
}

function ToolSection({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid gap-1">
      <p className="font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] break-words whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

/** One tool call together with its result; collapsed by default. */
function ToolCard({ tool, running }: { tool: ToolEntry; running: boolean }) {
  const status = tool.isError ? "failed" : tool.output !== null ? "done" : running ? "running" : "none";
  return (
    <Collapsible className="group/tool w-full rounded-lg border bg-background text-xs">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50">
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{toolSummary(tool.arguments)}</span>
        <Badge variant={status === "failed" ? "destructive" : status === "done" ? "secondary" : "outline"} className="shrink-0">
          {status === "running" ? <LoaderCircle className="animate-spin" /> : null}
          {status === "failed" ? "失败" : status === "done" ? "完成" : status === "running" ? "运行中" : "无结果"}
        </Badge>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-3 border-t p-3">
          {tool.arguments ? <ToolSection label="调用参数" text={tool.arguments} /> : null}
          {tool.output !== null ? <ToolSection label="返回结果" text={tool.output || "（空）"} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConversationItem({
  conversation,
  active,
  onSelect,
  onDelete,
}: {
  conversation: ConversationDoc;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex min-w-0 items-center gap-1 rounded-lg pr-1 transition-colors",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? "true" : undefined}
        className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <p className="truncate text-sm font-medium">{conversation.title || "新对话"}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{relativeTime(conversation.updatedAt)}</p>
      </button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
            aria-label="删除会话"
          >
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个会话？</AlertDialogTitle>
            <AlertDialogDescription>「{conversation.title || "新对话"}」将被删除，并同步到你的其他设备。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MessageRow({
  item,
  agent,
  userName,
  userAvatarUrl,
}: {
  item: RenderItem;
  agent: AgentDoc | undefined;
  userName: string;
  userAvatarUrl: string | null;
}) {
  if (item.role === "user") {
    return (
      <div className="flex min-w-0 flex-row-reverse items-start gap-3">
        <UserAvatar src={userAvatarUrl} name={userName} />
        <div className="max-w-[min(88%,48rem)] min-w-0 rounded-xl bg-primary px-4 py-2.5 text-sm leading-7 text-primary-foreground">
          <div className="break-words whitespace-pre-wrap">{item.text}</div>
        </div>
      </div>
    );
  }

  const last = item.blocks[item.blocks.length - 1];
  const waiting = item.sending && (!last || last.kind === "tool");
  if (item.blocks.length === 0 && !waiting) return null;

  return (
    <div className="flex min-w-0 items-start gap-3">
      <AgentAvatar agent={agent} />
      <div className="flex w-full max-w-3xl min-w-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl bg-muted px-4 py-3 text-sm leading-7 text-foreground">
        {item.blocks.map((block, index) => {
          if (block.kind === "thinking") {
            return <ThinkingBlock key={index} content={block.text} streaming={item.sending && index === item.blocks.length - 1} />;
          }
          if (block.kind === "tool") return <ToolCard key={index} tool={block.tool} running={item.sending} />;
          return (
            <div key={index} className={cn("min-w-0", block.error && "text-destructive")}>
              <MarkdownMessage content={block.text} />
              {block.error ? <p className="mt-2 text-xs opacity-80">发送失败</p> : null}
            </div>
          );
        })}
        {waiting ? <LoaderCircle className="size-4 animate-spin" /> : null}
      </div>
    </div>
  );
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
  // The title Agent only generates conversation titles, so it is not offered for new chats.
  const chatAgents = agents.filter((item) => item.role !== "title");
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

  function startConversation(chosen: AgentDoc) {
    if (!providers[0]) {
      toast.error("请先在手机端配置 Agent 和 Provider。");
      return;
    }
    const selectedProvider = providers.find((item) => item.models.some((model) => model.isEnabled && model.modelId === chosen.defaultModelId))
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
      agentId: chosen._id,
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
      <Empty className="min-h-[calc(100svh-3.5rem)] rounded-none">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Sparkles />
          </EmptyMedia>
          <EmptyTitle>准备你的第一个 AI 对话</EmptyTitle>
          <EmptyDescription>
            Web Messenger 使用你在手机端同步的 Agent、Provider 和模型配置。请先完成配置，再回到这里开始聊天。
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button asChild>
            <Link href="/console/manage">前往配置管理</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/console/account">打开用户中心</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  const groupedMessages = selected ? groupMessages(selected.messages) : [];

  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-h-0 w-full overflow-hidden bg-background">
      <aside
        className={cn(
          "shrink-0 overflow-hidden border-r bg-sidebar text-sidebar-foreground transition-[width] duration-300",
          sidebarOpen ? "w-72 max-md:absolute max-md:inset-y-14 max-md:left-0 max-md:z-10 max-md:shadow-lg" : "w-0 border-r-0",
        )}
      >
        <div className="flex h-full w-72 flex-col">
          <div className="flex items-center justify-between gap-2 p-3">
            <h1 className="px-1 text-sm font-semibold tracking-tight">对话</h1>
            <NewConversationMenu agents={chatAgents} onSelect={startConversation} align="end">
              <Button size="icon-sm" variant="outline" aria-label="新建对话">
                <MessageSquarePlus />
              </Button>
            </NewConversationMenu>
          </div>
          <div className="px-3 pb-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索对话..."
                className="pl-8"
              />
            </div>
          </div>
          <Separator />
          <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
            <div className="grid gap-1 p-2">
              {filteredConversations.length === 0 ? (
                <NewConversationMenu agents={chatAgents} onSelect={startConversation}>
                  <Button variant="ghost" className="justify-start text-muted-foreground">
                    <Plus />
                    开始一个新对话
                  </Button>
                </NewConversationMenu>
              ) : (
                filteredConversations.map((conversation) => (
                  <ConversationItem
                    key={conversation._id}
                    conversation={conversation}
                    active={conversation._id === selectedId}
                    onSelect={() => setSelectedId(conversation._id)}
                    onDelete={() => void deleteConversation(conversation._id)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
          <Separator />
          <p className="px-4 py-3 text-xs text-muted-foreground">
            {conversations.length} 个会话 · {providers.length} 个 Provider
          </p>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 min-w-0 shrink-0 items-center justify-between gap-3 border-b px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setSidebarOpen((open) => !open)} aria-label="切换会话栏">
              <PanelLeft />
            </Button>
            <AgentAvatar agent={agent} />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium">{selected?.title ?? "Messenger"}</h2>
              <p className="truncate text-xs text-muted-foreground">
                {agent?.name ?? "Agent"} · {availableModel ?? "未选择模型"}
              </p>
            </div>
          </div>
          <Badge variant="secondary" className="hidden shrink-0 sm:flex">
            <Check /> 已同步
          </Badge>
        </header>

        {!selected ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Bot />
              </EmptyMedia>
              <EmptyTitle>选择一个对话</EmptyTitle>
              <EmptyDescription>从左侧打开历史对话，或者新建一个空白会话。</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <NewConversationMenu agents={chatAgents} onSelect={startConversation}>
                <Button>
                  <MessageSquarePlus />
                  新建对话
                </Button>
              </NewConversationMenu>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
              <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
                {groupedMessages.length === 0 ? (
                  <Empty className="py-24">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <Sparkles />
                      </EmptyMedia>
                      <EmptyTitle>今天想一起完成什么？</EmptyTitle>
                      <EmptyDescription>提问、写作、头脑风暴，或者把一个复杂问题拆成下一步。</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  groupedMessages.map((message) => (
                    <MessageRow key={message.id} item={message} agent={agent} userName={userName} userAvatarUrl={userAvatarUrl} />
                  ))
                )}
                <div ref={bottomRef} />
              </div>
            </ScrollArea>
            <form onSubmit={sendMessage} className="shrink-0 px-4 pb-4 sm:px-6">
              <div className="mx-auto w-full min-w-0 max-w-3xl rounded-xl border bg-card p-2 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
                <Textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="给 Messenger 发消息...（Enter 发送，Shift + Enter 换行）"
                  className="min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
                  disabled={isSending}
                />
                <div className="flex min-w-0 items-center justify-between gap-3 px-1 pt-1">
                  <p className="min-w-0 truncate text-xs text-muted-foreground">
                    {availableModel ? `${availableModel} · 云端额度计费` : "请先选择模型"}
                  </p>
                  <Button type="submit" size="sm" disabled={!draft.trim() || isSending || selected.writable === false}>
                    {isSending ? <LoaderCircle className="animate-spin" /> : <Send />}
                    发送
                  </Button>
                </div>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
