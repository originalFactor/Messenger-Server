import type { CatalogMetadataMap, CatalogRateMap } from "@/lib/pi-catalog";
import type { ModelEmbed, UpstreamModelMeta } from "@/lib/types";
import type { MetaDraft, CapabilityKey } from "@/components/models/model-editor";
import { currentStoredCard, catalogModelDefault } from "@/lib/model-rates";
import { resolveModelCapabilities, withModelDisplayNames } from "@/lib/model-capabilities";
import { applyProviderModelMetadata } from "@/lib/provider-model-metadata";
import { formatPeakWindows, parsePeakWindows } from "@/lib/pricing";
import { modelSchema } from "@/lib/validation";
import type { Translator } from "@/lib/i18n";

export const PROVIDER_CAPABILITY_KEYS = ["displayName", "inputModalities", "reasoning", "reasoningEfforts", "contextWindow", "maxOutputTokens", "supportsTemperature", "supportsTopP", "supportsPenalties"] as const;
export const PROVIDER_RATE_KEYS = ["inputRate", "cacheReadRate", "cacheWriteRate", "outputRate"] as const;

export function providerModelMeta(model: ModelEmbed): UpstreamModelMeta {
  return { ...model.metadata, displayName: model.displayName || model.metadata?.displayName, contextWindow: model.contextWindow ?? model.metadata?.contextWindow,
    catalogModelId: model.catalogModelId, inputRate: model.inputRate, cacheReadRate: model.cacheReadRate,
    cacheWriteRate: model.cacheWriteRate, outputRate: model.outputRate, tiers: model.tiers, timeBased: model.timeBased };
}

export function providerCatalogMeta(rates: CatalogRateMap): Record<string, UpstreamModelMeta> {
  return Object.fromEntries(Object.entries(rates).map(([id, rate]) => [id, {
    inputRate: rate.input, cacheReadRate: rate.cacheRead, cacheWriteRate: rate.cacheWrite, outputRate: rate.output,
    tiers: rate.tiers?.map((tier) => ({ inputThreshold: tier.inputThreshold, inputThresholdInclusive: tier.inputThresholdInclusive,
      inputRate: tier.input, cacheReadRate: tier.cacheRead, cacheWriteRate: tier.cacheWrite, outputRate: tier.output })), timeBased: rate.timeBased,
  }]));
}

/** Same matching, field inheritance and full-list display-name collision rules as upstreams. */
export function providerModelRows(models: ModelEmbed[], rates: CatalogRateMap, capabilities: CatalogMetadataMap, loaded: boolean) {
  const names = withModelDisplayNames(new Map(models.map((model) => [model.modelId,
    applyProviderModelMetadata(resolveModelCapabilities(model.modelId, capabilities, { catalogModelId: model.catalogModelId }), model)!,
  ])));
  return new Map(models.map((model) => {
    const matched = catalogModelDefault(model.modelId, capabilities, model.catalogModelId) || catalogModelDefault(model.modelId, rates, model.catalogModelId);
    const configured = Boolean(model.displayName.trim() || model.contextWindow != null || PROVIDER_RATE_KEYS.some((key) => model[key] != null)
      || model.tiers?.length || model.timeBased || Object.values(model.metadata ?? {}).some((value) => value != null));
    return [model.id, { displayName: names.get(model.modelId)!.displayName ?? model.modelId,
      card: currentStoredCard(model.modelId, providerModelMeta(model), rates), unconfigured: loaded && !matched && !configured }];
  }));
}

/** Only explicit values enter the draft; inherited catalog defaults stay placeholders. */
export function providerModelDraft(model: ModelEmbed): MetaDraft {
  const meta = providerModelMeta(model);
  const draft: MetaDraft = { catalogModelId: model.catalogModelId ?? "" };
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    const value = meta[key];
    draft[key] = value == null ? "" : Array.isArray(value) ? value.join(", ") : String(value);
  }
  for (const key of PROVIDER_RATE_KEYS) draft[key] = model[key]?.toString() ?? "";
  if (model.tiers) draft.tiers = model.tiers.map((tier) => ({ inputThreshold: String(tier.inputThreshold), inputRate: tier.inputRate?.toString() ?? "",
    cacheReadRate: tier.cacheReadRate?.toString() ?? "", cacheWriteRate: tier.cacheWriteRate?.toString() ?? "", outputRate: tier.outputRate?.toString() ?? "" }));
  if (model.timeBased) draft.timeBased = { offPeakMultiplier: String(model.timeBased.offPeakMultiplier), peakWindows: formatPeakWindows(model.timeBased) };
  return draft;
}

/** Apply only touched fields, so bulk edits preserve every row's other overrides. */
export function applyProviderModelPatch(model: ModelEmbed, patch: Partial<MetaDraft>, t: Translator): ModelEmbed {
  const updated: ModelEmbed = { ...model };
  const metadata = { ...model.metadata };
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    if (patch[key] === undefined) continue;
    const value = patch[key]!.trim();
    delete metadata[key];
    if (key === "displayName") updated.displayName = value;
    else if (key === "contextWindow") {
      updated.contextWindow = value ? Number(value) : null;
      if (value) metadata.contextWindow = Number(value);
    } else if (value) {
      if (key === "inputModalities" || key === "reasoningEfforts") metadata[key] = [...new Set(value.split(/[,，\n]/).map((part) => part.trim()).filter(Boolean))];
      else if (key === "reasoning" || key.startsWith("supports")) Object.assign(metadata, { [key]: value === "true" });
      else Object.assign(metadata, { [key]: Number(value) });
    }
  }
  if (PROVIDER_CAPABILITY_KEYS.some((key) => patch[key] !== undefined)) updated.metadata = metadata;
  if (patch.catalogModelId !== undefined) updated.catalogModelId = patch.catalogModelId.trim() || null;
  for (const key of PROVIDER_RATE_KEYS) if (patch[key] !== undefined) updated[key] = patch[key]!.trim() ? Number(patch[key]) : null;
  if (patch.tiers !== undefined) updated.tiers = patch.tiers.length ? patch.tiers.map((tier) => ({ inputThreshold: Number(tier.inputThreshold),
    ...Object.fromEntries(PROVIDER_RATE_KEYS.map((key) => [key, tier[key].trim() ? Number(tier[key]) : null])),
    // Preserve inclusive thresholds on unchanged imported tiers.
    ...(model.tiers?.find((old) => old.inputThreshold === Number(tier.inputThreshold))?.inputThresholdInclusive ? { inputThresholdInclusive: true } : {}),
  })) : null;
  if (patch.timeBased !== undefined) {
    const parsed = parsePeakWindows(patch.timeBased.peakWindows, t);
    if ("error" in parsed) throw new Error(parsed.error);
    updated.timeBased = parsed.windows.length ? { offPeakMultiplier: patch.timeBased.offPeakMultiplier.trim() ? Number(patch.timeBased.offPeakMultiplier) : 1, peakWindows: parsed.windows } : null;
  }
  if (!modelSchema.safeParse(updated).success) throw new Error(t("请填写有效的模型元数据和非负倍率。"));
  return updated;
}

export function providerDraftCapabilities(draft: MetaDraft): Record<CapabilityKey, string> {
  return Object.fromEntries(PROVIDER_CAPABILITY_KEYS.map((key) => [key, draft[key] ?? ""])) as Record<CapabilityKey, string>;
}
