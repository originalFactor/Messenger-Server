"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resolveTools } from "@/components/messenger/chat-wire";
import type { ConversationDoc, ProviderDoc } from "@/lib/types";

type Props = {
  conversation: ConversationDoc;
  providers: ProviderDoc[];
  onClose: () => void;
  onSave: (conversation: ConversationDoc) => Promise<void>;
};

export function ConversationSettings({ conversation, providers, onClose, onSave }: Props) {
  const [model, setModel] = useState(conversation.overrideModelId ?? "");
  const [temperature, setTemperature] = useState(conversation.overrideTemperature?.toString() ?? "");
  const [topP, setTopP] = useState(conversation.overrideTopP?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(conversation.overrideMaxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(conversation.overrideReasoningEffort ?? "");
  const [toolsEnabled, setToolsEnabled] = useState(conversation.overrideToolsEnabled ?? null);
  const [toolsConfig, setToolsConfig] = useState(conversation.overrideToolsConfig ?? null);
  const [saving, setSaving] = useState(false);
  const models = [...new Set(providers.flatMap((provider) => provider.models.filter((item) => item.isEnabled).map((item) => item.modelId)))];
  if (model && !models.includes(model)) models.unshift(model);

  async function save() {
    const numeric = [temperature, topP, maxTokens].map((value) => value.trim() ? Number(value) : null);
    const [temp, top, max] = numeric;
    if (numeric.some((value) => value !== null && !Number.isFinite(value)) || (temp !== null && (temp < 0 || temp > 2)) || (top !== null && (top < 0 || top > 1)) || (max !== null && (!Number.isInteger(max) || max <= 0))) {
      toast.error("Temperature 需为 0–2，Top P 需为 0–1，Max tokens 需为正整数。");
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...conversation, overrideModelId: model || null, overrideTemperature: temp, overrideTopP: top, overrideMaxTokens: max, overrideReasoningEffort: reasoning.trim() || null, overrideToolsEnabled: toolsEnabled, overrideToolsConfig: toolsConfig, updatedAt: Date.now() });
      toast.success("对话设置已保存");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存对话设置失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="flex h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>对话设置</DialogTitle>
          <DialogDescription>仅影响当前对话。参数留空或选择“跟随 Agent”时使用 Agent 配置。</DialogDescription>
        </DialogHeader>
        <ScrollArea type="always" className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <fieldset disabled={saving} className="grid min-w-0 gap-5 pr-3 pb-2">
            <div className="grid gap-2">
              <Label htmlFor="conversation-model">模型</Label>
              <Select value={model || "__follow__"} onValueChange={(value) => setModel(value === "__follow__" ? "" : value)}>
                <SelectTrigger id="conversation-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="__follow__">跟随 Agent</SelectItem>{models.map((id) => <SelectItem key={id} value={id}>{id}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            {[
              { id: "temperature", label: "Temperature", value: temperature, set: setTemperature, step: "0.1" },
              { id: "top-p", label: "Top P (top_p)", value: topP, set: setTopP, step: "0.05" },
              { id: "max-tokens", label: "Max tokens (max_tokens)", value: maxTokens, set: setMaxTokens, step: "1" },
              { id: "reasoning", label: "Reasoning effort", value: reasoning, set: setReasoning, step: undefined },
            ].map((field) => (
              <div key={field.id} className="grid gap-2">
                <Label htmlFor={`conversation-${field.id}`}>{field.label}</Label>
                <Input id={`conversation-${field.id}`} type={field.step ? "number" : "text"} step={field.step} value={field.value} onChange={(event) => field.set(event.target.value)} placeholder={field.step ? "跟随 Agent" : "跟随 Agent / low / medium / high"} />
              </div>
            ))}
            <div className="grid gap-2">
              <Label htmlFor="conversation-tools">工具</Label>
              <Select value={toolsEnabled === null ? "follow" : toolsEnabled ? "on" : "off"} onValueChange={(value) => setToolsEnabled(value === "follow" ? null : value === "on")}>
                <SelectTrigger id="conversation-tools" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="follow">跟随 Agent</SelectItem><SelectItem value="on">开启</SelectItem><SelectItem value="off">关闭</SelectItem></SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">工具仅在项目对话且所属设备在线时可用。</p>
            </div>
            <div className="grid gap-2">
              <Label className="flex items-center gap-2"><Checkbox checked={toolsConfig === null} onCheckedChange={(checked) => setToolsConfig(checked ? null : {})} />工具配置跟随 Agent</Label>
              {toolsConfig !== null ? resolveTools(true, null, true).map((tool) => <Label key={tool.function.name} className="flex items-center gap-2"><Checkbox checked={toolsConfig[tool.function.name] !== false} onCheckedChange={(checked) => setToolsConfig({ ...toolsConfig, [tool.function.name]: checked === true })} />{tool.function.name}</Label>) : null}
            </div>
          </fieldset>
        </ScrollArea>
        <div className="flex shrink-0 justify-end gap-2"><Button variant="outline" disabled={saving} onClick={onClose}>取消</Button><Button disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></div>
      </DialogContent>
    </Dialog>
  );
}
