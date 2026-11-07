"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import { useTranslator } from "@/components/i18n/locale-provider";
import type { useRemoteDevice } from "@/components/messenger/remote";

type Remote = ReturnType<typeof useRemoteDevice>;
type Device = { id: string; name: string };
type Catalog = {
  agents: Device[];
  projects: Device[];
  sessions: { id: string; title: string }[];
};
type Message = { id: string; role: string; text: string; status: string };
type Option = { id: string; name: string };
const emptyCatalog: Catalog = { agents: [], projects: [], sessions: [] };

export function DeviceControl({ open, onOpenChange, remote }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remote: Remote;
}) {
  const t = useTranslator();
  const { controlReady, controlRequest, controlSignal } = remote;
  const [devices, setDevices] = useState<Device[]>([]);
  const [device, setDevice] = useState("");
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [session, setSession] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [writable, setWritable] = useState<boolean | null>(null);
  const [before, setBefore] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [partial, setPartial] = useState("");
  const [tool, setTool] = useState("");
  const [permissionContext, setPermissionContext] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [error, setError] = useState("");
  const [turn, setTurn] = useState("");
  const [loading, setLoading] = useState(false);
  const currentDevice = useRef("");
  const wasOnline = useRef(false);
  const end = useRef<HTMLDivElement>(null);
  const draftKey = JSON.stringify([device, session]);
  const online = controlReady && devices.some(({ id }) => id === device);

  useEffect(() => {
    if (!open || !controlReady) return;
    const controller = new AbortController();
    const refresh = () => {
      void fetch("/api/remote/control", { cache: "no-store", signal: controller.signal })
        .then(async (response) => {
          if (response.ok) setDevices((await response.json() as { devices: Device[] }).devices);
        }).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 3_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [open, controlReady]);

  useEffect(() => {
    if (open && (partial || turn)) end.current?.scrollIntoView({ block: "end" });
  }, [open, partial, turn]);

  useEffect(() => {
    const reconnected = open && online && !wasOnline.current;
    wasOnline.current = open && online;
    if (!reconnected || !session || turn) return;
    let active = true;
    void controlRequest(device, { action: "history", sessionId: session }).result.then((result) => {
      if (!active) return;
      setMessages(result.messages as Message[]);
      setBefore(result.before as string | null);
      setWritable(typeof result.writable === "boolean" ? result.writable : null);
      setPartial("");
      setError("");
    }, (error: Error) => {
      if (active) setError(error.message);
    });
    return () => { active = false; };
  }, [controlRequest, device, online, open, session, turn]);

  function report(error: unknown) {
    setError(error instanceof Error ? error.message : String(error));
  }

  async function chooseDevice(id: string) {
    currentDevice.current = id;
    setDevice(id);
    setCatalog(emptyCatalog);
    setSession("");
    setProject("");
    setAgent("");
    setMessages([]);
    setWritable(null);
    setError("");
    if (!id) return;
    setLoading(true);
    try {
      const data = await controlRequest(id, { action: "catalog" }).result as unknown as Catalog;
      if (currentDevice.current !== id) return;
      setCatalog(data);
      setAgent(data.agents[0]?.id ?? "");
    } catch (error) {
      if (currentDevice.current === id) report(error);
    } finally {
      if (currentDevice.current === id) setLoading(false);
    }
  }

  async function history(id: string, cursor?: string) {
    const data = await controlRequest(device, { action: "history", sessionId: id, before: cursor }).result;
    const rows = data.messages as Message[];
    setMessages((previous) => cursor ? [...rows, ...previous] : rows);
    setBefore(data.before as string | null);
    setWritable(typeof data.writable === "boolean" ? data.writable : null);
  }

  async function selectSession(id: string) {
    setSession(id);
    setMessages([]);
    setBefore(null);
    setWritable(null);
    if (id) await history(id);
  }

  async function loadSession(id: string) {
    setLoading(true);
    setError("");
    try {
      await selectSession(id);
    } catch (error) {
      report(error);
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    setLoading(true);
    setError("");
    try {
      const data = await controlRequest(device, { action: "create", agentId: agent, projectId: project || null }).result;
      const id = String(data.sessionId);
      setCatalog((previous) => ({ ...previous, sessions: [{ id, title: t("新对话") }, ...previous.sessions] }));
      await selectSession(id);
    } catch (error) {
      report(error);
    } finally {
      setLoading(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = (drafts[draftKey] ?? "").trim();
    if (!text || !session || !online || turn || loading) return;
    setError("");
    setPartial("");
    setTool("");
    const request = controlRequest(device, { action: "prompt", sessionId: session, text }, (event) => {
      if (event.type === "TextDelta") setPartial((previous) => previous + String(event.text ?? ""));
      if (event.type === "ToolCallStarted") setTool(String(event.name ?? ""));
      if (event.type === "ToolCallFinished") setTool("");
      if (event.type === "ToolUpdate") {
        const update = event.update as { title?: string; status?: string };
        setTool(["completed", "failed"].includes(update.status ?? "") ? "" : update.title ?? update.status ?? "");
      }
      if (event.type === "Permission") {
        const details = event.tool as { title?: string; detail?: string };
        setPermissionContext([details.title, details.detail].filter(Boolean).join("\n"));
        setOptions(event.options as Option[]);
      }
      if (event.type === "TurnStarted") setDrafts((previous) => ({ ...previous, [draftKey]: "" }));
    });
    setTurn(request.id);
    try {
      await request.result;
      setDrafts((previous) => ({ ...previous, [draftKey]: "" }));
    } catch (error) {
      report(error);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        await history(session);
        setPartial("");
      } catch {
        // Keep the streamed text until history can be read again.
      }
      setOptions([]);
      setTool("");
      setTurn("");
    }
  }

  async function changeMode() {
    if (writable === null || !session || turn || loading) return;
    setLoading(true);
    try {
      const reply = await controlRequest(device, { action: "setMode", sessionId: session, writable: !writable }).result;
      setWritable(reply.writable === true);
    } catch (error) {
      report(error);
    } finally {
      setLoading(false);
    }
  }

  async function signal(optionId?: string) {
    try {
      await controlSignal(turn, optionId);
      if (optionId) setOptions([]);
    } catch (error) {
      report(error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85dvh] max-h-[85dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("设备远程会话")}</DialogTitle>
          <DialogDescription>{t("模型和工具在所选设备上运行。")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <Select value={device} disabled={!!turn || loading} onValueChange={(id) => void chooseDevice(id)}>
            <SelectTrigger className="w-full" aria-label={t("选择设备")}><SelectValue placeholder={t("选择设备")} /></SelectTrigger>
            <DeviceOptions>
              {device && !devices.some(({ id }) => id === device) ? <SelectItem value={device} disabled>{t("设备已离线")}</SelectItem> : null}
              {devices.map(({ id, name }) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </DeviceOptions>
          </Select>
          <Select value={session} disabled={!online || !!turn || loading} onValueChange={(id) => void loadSession(id)}>
            <SelectTrigger className="w-full" aria-label={t("选择会话")}><SelectValue placeholder={t("选择会话")} /></SelectTrigger>
            <DeviceOptions>
              {catalog.sessions.map(({ id, title }) => <SelectItem key={id} value={id}>{title}</SelectItem>)}
            </DeviceOptions>
          </Select>
          <Select value={agent} disabled={!online || !!turn || loading} onValueChange={setAgent}>
            <SelectTrigger className="w-full" aria-label={t("选择 Agent")}><SelectValue placeholder={t("选择 Agent")} /></SelectTrigger>
            <DeviceOptions>
              {catalog.agents.map(({ id, name }) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </DeviceOptions>
          </Select>
          <Select value={project || "__none__"} disabled={!online || !!turn || loading} onValueChange={(id) => setProject(id === "__none__" ? "" : id)}>
            <SelectTrigger className="w-full" aria-label={t("选择工作区")}><SelectValue /></SelectTrigger>
            <DeviceOptions>
              <SelectItem value="__none__">{t("无工作区")}</SelectItem>
              {catalog.projects.map(({ id, name }) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </DeviceOptions>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={!online || !agent || !!turn || loading} onClick={() => void create()}>{t("新对话")}</Button>
          <Button size="sm" variant="outline" disabled={!online || !session || !!turn || loading} onClick={() => void loadSession(session)}>{t("刷新历史")}</Button>
          {writable !== null ? <Button size="sm" variant="outline" disabled={!online || !!turn || loading}
            aria-pressed={writable} onClick={() => void changeMode()}>{writable ? t("可写模式") : t("只读模式")}</Button> : null}
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-1">
            {before ? <Button size="sm" variant="ghost" disabled={!online || !!turn} onClick={() => void history(session, before).catch(report)}>{t("加载更早的消息")}</Button> : null}
            {messages.map((row) => (
              <div key={row.id} className={`whitespace-pre-wrap break-words rounded-md p-3 text-sm ${row.status === "error" ? "bg-destructive/10 text-destructive" : row.role === "user" ? "bg-primary/10" : "bg-muted"}`}>
                <div className="mb-1 text-xs font-medium text-muted-foreground">{row.role}</div>{row.text}
              </div>
            ))}
            {partial ? <div className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">{partial}</div> : null}
            {tool ? <p className="text-sm text-muted-foreground">{t("工具")}: {tool}</p> : null}
            {options.length ? (
              <div className="flex flex-wrap items-center gap-2 rounded border p-2">
                <div className="w-full whitespace-pre-wrap break-words text-sm">
                  <p>{t("工具请求授权")}</p>
                  {permissionContext ? <p className="text-muted-foreground">{permissionContext}</p> : null}
                </div>
                {options.map(({ id, name }) => <Button key={id} variant="outline" size="sm" onClick={() => void signal(id)}>{name}</Button>)}
              </div>
            ) : null}
            <div ref={end} />
          </div>
        </ScrollArea>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <form onSubmit={send} className="flex items-end gap-2">
          <Textarea aria-label={t("消息")} value={drafts[draftKey] ?? ""} disabled={!session || !!turn}
            onChange={(event) => setDrafts((previous) => ({ ...previous, [draftKey]: event.target.value }))} />
          {turn ? <Button type="button" variant="outline" onClick={() => void signal()}>{t("停止生成")}</Button> :
            <Button type="submit" disabled={!online || !session || loading || !drafts[draftKey]?.trim()}>{t("发送")}</Button>}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeviceOptions({ children }: { children: ReactNode }) {
  return (
    <SelectContent position="popper" className="overflow-hidden [&_[data-radix-select-viewport]]:!h-auto [&_[data-radix-select-viewport]]:!overflow-hidden">
      <ScrollArea className="[&_[data-slot=scroll-area-viewport]]:max-h-60">{children}</ScrollArea>
    </SelectContent>
  );
}
