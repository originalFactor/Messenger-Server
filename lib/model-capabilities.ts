import type { CatalogMetadataMap, CatalogModelMetadata } from "@/lib/pi-catalog";
import type { UpstreamDoc, UpstreamModelMeta } from "@/lib/types";
import { catalogModelDefault } from "@/lib/model-rates";

/** Normalize inherited catalog labels while preserving acronyms and existing casing. */
export function normalizeModelDisplayName(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1)
    .replace(/-/g, " ")
    .trim()
    .replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

/** Field-wise inheritance, shared by Web, model discovery and admin previews. */
export function resolveModelCapabilities(modelId: string, catalog: CatalogMetadataMap, custom?: UpstreamModelMeta): CatalogModelMetadata {
  const base = catalogModelDefault(modelId, catalog, custom?.catalogModelId);
  const reasoning = custom?.reasoning ?? base?.reasoning ?? null;
  const efforts = reasoning === false ? [] : custom?.reasoningEfforts ?? base?.reasoningEfforts ?? [];
  return {
    displayName: custom?.displayName?.trim() ? custom.displayName : base?.displayName?.trim() ? normalizeModelDisplayName(base.displayName) : normalizeModelDisplayName(modelId),
    inputModalities: custom?.inputModalities ?? base?.inputModalities ?? ["text"],
    reasoning,
    reasoningEfforts: efforts,
    defaultReasoningEffort: base?.defaultReasoningEffort && efforts.includes(base.defaultReasoningEffort) ? base.defaultReasoningEffort : null,
    contextWindow: custom?.contextWindow ?? base?.contextWindow ?? null,
    maxOutputTokens: custom?.maxOutputTokens ?? base?.maxOutputTokens ?? null,
    supportsTemperature: custom?.supportsTemperature ?? base?.supportsTemperature ?? true,
    supportsTopP: custom?.supportsTopP ?? base?.supportsTopP ?? true,
    supportsPenalties: custom?.supportsPenalties ?? base?.supportsPenalties ?? true,
  };
}

/** Resolve collisions over the full model list, before any UI filtering. */
export function withModelDisplayNames<T extends { displayName: string | null }>(models: ReadonlyMap<string, T>): Map<string, T> {
  const counts = new Map<string, number>();
  for (const model of models.values()) {
    const key = model.displayName?.trim().toLowerCase() ?? "";
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Map([...models].map(([modelId, model]) => {
    const key = model.displayName?.trim().toLowerCase() ?? "";
    return [modelId, !key || (counts.get(key) ?? 0) > 1
      ? { ...model, displayName: normalizeModelDisplayName(modelId) } : model];
  }));
}

/** Upstreams arrive in routing priority order; one capability card per served model. */
export function resolveUpstreamCapabilities(upstreams: readonly Pick<UpstreamDoc, "models" | "modelMeta">[], catalog: CatalogMetadataMap): Map<string, CatalogModelMetadata> {
  const models = new Map<string, CatalogModelMetadata>();
  for (const upstream of upstreams) {
    for (const modelId of upstream.models) {
      if (!models.has(modelId)) models.set(modelId, resolveModelCapabilities(modelId, catalog, upstream.modelMeta?.[modelId]));
    }
  }
  return withModelDisplayNames(models);
}
