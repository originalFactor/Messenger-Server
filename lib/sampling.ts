/** Optional Web sampling parameters; numeric compatibility fields remain in cloud sync. */
export interface SamplingSettings {
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  temperatureEnabled?: boolean;
  topPEnabled?: boolean;
}

export const SAMPLING_FIELDS = [
  { key: "temperature", wire: "temperature", override: "overrideTemperature", follow: "followAgentTemperature", label: "Temperature", min: 0, max: 2, step: "0.1" },
  { key: "topP", wire: "top_p", override: "overrideTopP", follow: "followAgentTopP", label: "Top P (top_p)", min: 0, max: 1, step: "0.05" },
  { key: "frequencyPenalty", wire: "frequency_penalty", override: "overrideFrequencyPenalty", follow: "followAgentFrequencyPenalty", label: "Frequency penalty", min: -2, max: 2, step: "0.1" },
  { key: "presencePenalty", wire: "presence_penalty", override: "overridePresencePenalty", follow: "followAgentPresencePenalty", label: "Presence penalty", min: -2, max: 2, step: "0.1" },
] as const;
export type SamplingKey = (typeof SAMPLING_FIELDS)[number]["key"];
export type SamplingOverrides = Partial<Record<(typeof SAMPLING_FIELDS)[number]["override"], number | null>> &
  Partial<Record<(typeof SAMPLING_FIELDS)[number]["follow"], boolean>>;

export function parseSamplingInputs(inputs: Record<SamplingKey, string>): Record<SamplingKey, number | null> {
  const result = {} as Record<SamplingKey, number | null>;
  for (const field of SAMPLING_FIELDS) {
    const text = inputs[field.key].trim();
    const value = text ? Number(text) : null;
    if (value !== null && (!Number.isFinite(value) || value < field.min || value > field.max)) {
      throw new Error(`${field.label} 需为 ${field.min}–${field.max}，或留空不发送。`);
    }
    result[field.key] = value;
  }
  return result;
}

/** Empty is omitted, including after inheritance; explicit zero is preserved. */
export function samplingRequestFields(agent: SamplingSettings, conversation?: SamplingOverrides, capabilities?: { supportsTemperature?: boolean; supportsTopP?: boolean; supportsPenalties?: boolean }): Record<string, number> {
  const result: Record<string, number> = {};
  for (const field of SAMPLING_FIELDS) {
    if ((field.key === "temperature" && capabilities?.supportsTemperature === false)
      || (field.key === "topP" && capabilities?.supportsTopP === false)
      || ((field.key === "frequencyPenalty" || field.key === "presencePenalty") && capabilities?.supportsPenalties === false)) continue;
    const override = conversation?.[field.override];
    // Legacy conversations used null to follow Agent. Explicit false adds an omit state.
    const follows = conversation?.[field.follow] ?? (override == null);
    const enabled = field.key === "temperature" ? agent.temperatureEnabled !== false
      : field.key === "topP" ? agent.topPEnabled !== false : true;
    const value = conversation && !follows ? override : enabled ? agent[field.key] : null;
    if (value != null) result[field.wire] = value;
  }
  return result;
}
