"use client";

import { useTranslator } from "@/components/i18n/locale-provider";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ModelMetadataSummary, useModelMetadata } from "@/components/messenger/model-metadata";
import { ReasoningEffortSelect } from "@/components/messenger/reasoning-effort-select";
import { SAMPLING_FIELDS, parseSamplingInputs, type SamplingKey } from "@/lib/sampling";
import { resolveTools } from "@/components/messenger/chat-wire";
import { BUILTIN_PROVIDER_ID, resolveConversationModel } from "@/lib/conversation-model";
import type { ConversationDoc, ProviderDoc } from "@/lib/types";

type Props = {
  conversation: ConversationDoc;
  providers: ProviderDoc[];
  agentModelId: string | null;
  onClose: () => void;
  onSave: (conversation: ConversationDoc) => Promise<void>;
};

export function ConversationSettings({ conversation, providers, agentModelId, onClose, onSave }: Props) {
  const t = useTranslator();
  const [providerId, setProviderId] = useState(conversation.overrideModelId ? conversation.providerId : null);
  const [model, setModel] = useState(conversation.overrideModelId ?? "");
  const [samplingInputs, setSamplingInputs] = useState(() => Object.fromEntries(
    SAMPLING_FIELDS.map((field) => [field.key, conversation[field.override]?.toString() ?? ""]),
  ) as Record<SamplingKey, string>);
  const [followSampling, setFollowSampling] = useState(() => Object.fromEntries(
    SAMPLING_FIELDS.map((field) => [field.key, conversation[field.follow] ?? (conversation[field.override] == null)]),
  ) as Record<SamplingKey, boolean>);
  const [maxTokens, setMaxTokens] = useState(conversation.overrideMaxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(conversation.overrideReasoningEffort ?? "");
  const [toolsEnabled, setToolsEnabled] = useState(conversation.overrideToolsEnabled ?? null);
  const [toolsConfig, setToolsConfig] = useState(conversation.overrideToolsConfig ?? null);
  const [saving, setSaving] = useState(false);
  const overridingModel = providerId !== null;
  const selectedProvider = providers.find((provider) => provider._id === providerId);
  const models = selectedProvider?.models.filter((item) => item.isEnabled) ?? [];
  const savedModelUnavailable = Boolean(model && !models.some((item) => item.modelId === model));
  const inherited = resolveConversationModel(providers, agentModelId, conversation.overrideModelId ? null : conversation);
  const effectiveModel = overridingModel ? model || null : inherited.modelId;
  const effectiveProvider = overridingModel ? selectedProvider : inherited.provider;
  const modelMetadata = useModelMetadata(effectiveModel, effectiveProvider?._id === BUILTIN_PROVIDER_ID,
    effectiveProvider?.models.find((item) => item.modelId === effectiveModel));
  const modelCapabilities = modelMetadata.metadata;

  async function save() {
    if (overridingModel && !model) {
      toast.error(t("请先选择模型"));
      return;
    }

    let sampling;
    try { sampling = parseSamplingInputs(samplingInputs, t); } catch (error) {
      toast.error(error instanceof Error ? error.message : t("采样参数无效"));
      return;
    }
    const max = maxTokens.trim() ? Number(maxTokens) : null;
    if (max !== null && (!Number.isInteger(max) || max <= 0)) {
      toast.error(t("Max tokens 需为正整数。"));
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...conversation, providerId: providerId ?? inherited.provider?._id ?? "", overrideModelId: overridingModel ? model : null, overrideTemperature: sampling.temperature, overrideTopP: sampling.topP, overrideFrequencyPenalty: sampling.frequencyPenalty, overridePresencePenalty: sampling.presencePenalty, followAgentTemperature: followSampling.temperature, followAgentTopP: followSampling.topP, followAgentFrequencyPenalty: followSampling.frequencyPenalty, followAgentPresencePenalty: followSampling.presencePenalty, overrideMaxTokens: max, overrideReasoningEffort: reasoning.trim() || null, overrideToolsEnabled: toolsEnabled, overrideToolsConfig: toolsConfig, updatedAt: Date.now() });
      toast.success(t("对话设置已保存"));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("保存对话设置失败"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="flex h-[calc(100dvh-2rem)] flex-col sm:max-w-xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("对话设置")}</DialogTitle>
          <DialogDescription>{t("仅影响当前对话。采样参数勾选“跟随 Agent”时继承；取消勾选后留空则不发送该参数。")}</DialogDescription>
        </DialogHeader>
        <ScrollArea type="always" className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <fieldset disabled={saving} className="grid min-w-0 gap-5 pr-3 pb-2">
            <div className="grid gap-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="conversation-provider">Provider</Label>
                  <Select value={overridingModel ? `provider:${providerId}` : "follow"} disabled={saving} onValueChange={(value) => {
                    setProviderId(value === "follow" ? null : value.slice("provider:".length));
                    setModel("");
                  }}>
                    <SelectTrigger id="conversation-provider" className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="follow">{t("跟随 Agent")}</SelectItem>
                      {overridingModel && !selectedProvider ? <SelectItem value={`provider:${providerId}`} disabled>{providerId ? `${providerId} · ` : ""}{t("Provider 不可用")}</SelectItem> : null}
                      {providers.map((provider) => <SelectItem key={provider._id} value={`provider:${provider._id}`}>{provider.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid min-w-0 gap-2">
                  <Label htmlFor="conversation-model">{t("模型")}</Label>
                  <Select value={overridingModel ? model : ""} disabled={saving || !selectedProvider || !models.length && !savedModelUnavailable} onValueChange={setModel}>
                    <SelectTrigger id="conversation-model" className="w-full"><SelectValue placeholder={!overridingModel
                      ? inherited.model?.displayName || inherited.modelId || t("跟随 Agent")
                      : models.length ? t("选择模型") : t("该 Provider 暂无模型")} /></SelectTrigger>
                    <SelectContent>
                      {savedModelUnavailable ? <SelectItem value={model} disabled>{model} · {t("模型不可用")}</SelectItem> : null}
                      {models.map((item) => <SelectItem key={item.id} value={item.modelId}>{item.displayName || item.modelId}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <ModelMetadataSummary state={modelMetadata} />
            </div>
            {SAMPLING_FIELDS.map((field) => (
              <div key={field.key} className="grid gap-2">
                <Label htmlFor={`conversation-${field.key}`}>{t(field.label)}</Label>
                <Label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={followSampling[field.key]} onCheckedChange={(checked) => setFollowSampling({ ...followSampling, [field.key]: checked === true })} />{t("跟随 Agent")}{" "}</Label>
                <Input id={`conversation-${field.key}`} type="number" step={field.step} min={field.min} max={field.max} disabled={followSampling[field.key] || (field.key === "temperature" ? modelCapabilities?.supportsTemperature === false : field.key === "topP" ? modelCapabilities?.supportsTopP === false : modelCapabilities?.supportsPenalties === false)} value={samplingInputs[field.key]} onChange={(event) => setSamplingInputs({ ...samplingInputs, [field.key]: event.target.value })} placeholder={followSampling[field.key] ? t("跟随 Agent") : t("留空不发送")} />
              </div>
            ))}
            <div className="grid gap-2">
              <Label htmlFor="conversation-max-tokens">Max tokens</Label>
              <Input id="conversation-max-tokens" type="number" step="1" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} placeholder={t("跟随 Agent")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="conversation-reasoning">Reasoning effort</Label>
              <ReasoningEffortSelect id="conversation-reasoning" metadata={modelCapabilities} value={reasoning} onChange={setReasoning} disabled={saving} defaultLabel={t("跟随 Agent")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="conversation-tools">{t("工具")}</Label>
              <Select value={toolsEnabled === null ? "follow" : toolsEnabled ? "on" : "off"} onValueChange={(value) => setToolsEnabled(value === "follow" ? null : value === "on")}>
                <SelectTrigger id="conversation-tools" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="follow">{t("跟随 Agent")}</SelectItem><SelectItem value="on">{t("开启")}</SelectItem><SelectItem value="off">{t("关闭")}</SelectItem></SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("工具仅在项目对话且所属设备在线时可用。")}</p>
            </div>
            <div className="grid gap-2">
              <Label className="flex items-center gap-2"><Checkbox checked={toolsConfig === null} onCheckedChange={(checked) => setToolsConfig(checked ? null : {})} />{t("工具配置跟随 Agent")}</Label>
              {toolsConfig !== null ? resolveTools(true, null, true).map((tool) => <Label key={tool.function.name} className="flex items-center gap-2"><Checkbox checked={toolsConfig[tool.function.name] !== false} onCheckedChange={(checked) => setToolsConfig({ ...toolsConfig, [tool.function.name]: checked === true })} />{tool.function.name}</Label>) : null}
            </div>
          </fieldset>
        </ScrollArea>
        <div className="flex shrink-0 justify-end gap-2"><Button variant="outline" disabled={saving} onClick={onClose}>{t("取消")}</Button><Button disabled={saving} onClick={() => void save()}>{saving ? t("保存中…") : t("保存")}</Button></div>
      </DialogContent>
    </Dialog>
  );
}
