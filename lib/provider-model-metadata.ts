import type { CatalogModelMetadata } from "@/lib/pi-catalog";
import type { ModelEmbed } from "@/lib/types";

/** Provider-supplied fields override catalog defaults independently, including false and zero. */
export function applyProviderModelMetadata(base: CatalogModelMetadata | null, model?: ModelEmbed): CatalogModelMetadata | null {
  if (!model) return base;
  const supplied = model.metadata;
  if (!supplied && model.contextWindow == null && !model.displayName.trim()) return base;
  const metadata: CatalogModelMetadata = {
    displayName: model.displayName.trim() || supplied?.displayName || base?.displayName || model.modelId,
    contextWindow: model.contextWindow ?? supplied?.contextWindow ?? base?.contextWindow ?? null,
    maxOutputTokens: supplied?.maxOutputTokens ?? base?.maxOutputTokens ?? null,
    inputModalities: supplied?.inputModalities ?? base?.inputModalities ?? ["text"],
    reasoning: supplied?.reasoning ?? base?.reasoning ?? null,
    reasoningEfforts: supplied?.reasoningEfforts ?? base?.reasoningEfforts ?? [],
    defaultReasoningEffort: supplied?.defaultReasoningEffort ?? base?.defaultReasoningEffort ?? null,
    supportsTemperature: supplied?.supportsTemperature ?? base?.supportsTemperature ?? true,
    supportsTopP: supplied?.supportsTopP ?? base?.supportsTopP ?? true,
    supportsPenalties: supplied?.supportsPenalties ?? base?.supportsPenalties ?? true,
  };
  if (metadata.reasoning === false) metadata.reasoningEfforts = [];
  if (metadata.defaultReasoningEffort && !metadata.reasoningEfforts.includes(metadata.defaultReasoningEffort)) metadata.defaultReasoningEffort = null;
  return metadata;
}

/** Preserve manual-only rows, local IDs/names and disabled selections on every refresh. */
export function mergeProviderModels(existing: ModelEmbed[], fetched: ModelEmbed[]): ModelEmbed[] {
  const remaining = new Map(fetched.map((model) => [model.modelId, model]));
  const models = existing.map((model) => {
    const update = remaining.get(model.modelId);
    if (!update) return model;
    remaining.delete(model.modelId);
    return { ...model, ...update, id: model.id, displayName: model.displayName.trim() && model.displayName !== model.metadata?.displayName ? model.displayName : update.displayName || model.displayName,
      isEnabled: model.isEnabled, createdAt: model.createdAt,
      metadata: update.metadata ? { ...model.metadata, ...update.metadata } : model.metadata };
  });
  return [...models, ...remaining.values()];
}

/** Older sync clients omit Web extensions; omission must not erase saved metadata. */
export function preserveProviderModelFields(models: ModelEmbed[], previous: ModelEmbed[]): ModelEmbed[] {
  const oldById = new Map(previous.map((model) => [model.id, model]));
  return models.map((model) => {
    const old = oldById.get(model.id);
    if (!old || old.modelId !== model.modelId) return model;
    const preserved: Partial<ModelEmbed> = {};
    for (const key of ["contextWindow", "inputRate", "outputRate", "cacheReadRate", "cacheWriteRate", "tiers", "timeBased", "metadata"] as const) {
      if (model[key] === undefined && old[key] !== undefined) Object.assign(preserved, { [key]: old[key] });
    }
    return { ...preserved, ...model };
  });
}
