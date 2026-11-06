import { modelSchema, providerModelMetadataSchema, pricingTierInputSchema, pricingScheduleInputSchema } from "@/lib/validation";
import type { ModelEmbed } from "@/lib/types";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const aliases = {
  displayName: "display_name", contextWindow: "context_window", maxOutputTokens: "max_output_tokens",
  inputModalities: "input_modalities", reasoning: "reasoning", reasoningEfforts: "reasoning_efforts",
  defaultReasoningEffort: "default_reasoning_effort", supportsTemperature: "supports_temperature",
  supportsTopP: "supports_top_p", supportsPenalties: "supports_penalties",
} as const;

/** Standard OpenAI/Anthropic and Gemini lists, plus Messenger's snake_case extensions. */
export function parseProviderModels(payload: unknown): ModelEmbed[] {
  const body = record(payload);
  const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : null;
  if (!entries) throw new Error("The provider did not return a recognizable model list.");
  if (entries.length > 5_000) throw new Error("The provider returned too many models (maximum 5000).");
  const models = new Map<string, ModelEmbed>();
  for (const entry of entries) {
    const raw = record(entry);
    const id = typeof raw.id === "string" ? raw.id : raw.name;
    if (typeof id !== "string") continue;
    const modelId = id.replace(/^models\//, "").trim();
    if (!modelId || modelId.length > 500 || models.has(modelId)) continue;
    const nested = record(raw.metadata);
    const metadata: Record<string, unknown> = {};
    for (const [key, alias] of Object.entries(aliases)) {
      const value = raw[alias] ?? raw[key] ?? nested[key] ?? nested[alias];
      const parsed = providerModelMetadataSchema.shape[key as keyof typeof aliases].safeParse(value);
      if (parsed.success && parsed.data !== undefined) metadata[key] = Array.isArray(parsed.data) ? [...new Set(parsed.data)] : parsed.data;
    }
    const model: ModelEmbed = {
      id: crypto.randomUUID(), modelId, displayName: typeof metadata.displayName === "string" ? metadata.displayName : "",
      isEnabled: true, createdAt: Date.now(),
    };
    if (Object.keys(metadata).length) model.metadata = metadata;
    if (typeof metadata.contextWindow === "number") model.contextWindow = metadata.contextWindow;
    for (const [key, alias] of [["inputRate", "input_rate"], ["outputRate", "output_rate"], ["cacheReadRate", "cache_read_rate"], ["cacheWriteRate", "cache_write_rate"]] as const) {
      const value = raw[alias] ?? raw[key];
      const parsed = modelSchema.shape[key].safeParse(value);
      if (parsed.success && parsed.data !== undefined) model[key] = parsed.data;
    }
    if (Array.isArray(raw.tiers)) {
      const tiers = raw.tiers.slice(0, 10).flatMap((value) => {
        const tier = record(value);
        const parsed = pricingTierInputSchema.safeParse({
          inputThreshold: tier.input_tokens_above ?? tier.inputThreshold,
          inputThresholdInclusive: tier.input_tokens_above_inclusive ?? tier.inputThresholdInclusive,
          inputRate: tier.input_rate ?? tier.inputRate, outputRate: tier.output_rate ?? tier.outputRate,
          cacheReadRate: tier.cache_read_rate ?? tier.cacheReadRate, cacheWriteRate: tier.cache_write_rate ?? tier.cacheWriteRate,
        });
        return parsed.success ? [parsed.data] : [];
      });
      if (tiers.length) model.tiers = tiers;
    }
    const schedule = record(raw.time_based ?? raw.timeBased);
    const windows = schedule.peak_windows ?? schedule.peakWindows;
    if (Array.isArray(windows)) {
      const parsed = pricingScheduleInputSchema.safeParse({
        offPeakMultiplier: schedule.off_peak_multiplier ?? schedule.offPeakMultiplier,
        peakWindows: windows.map((value) => {
          const window = record(value);
          return { weekdays: window.weekdays, startMinute: window.start_minute ?? window.startMinute, endMinute: window.end_minute ?? window.endMinute };
        }),
      });
      if (parsed.success) model.timeBased = parsed.data;
    }
    const parsed = modelSchema.safeParse(model);
    if (parsed.success) models.set(modelId, parsed.data);
  }
  return [...models.values()];
}

