/*
 * Copyright 2026 ECSDevs
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { JWTPayload } from "jose";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus = "SENDING" | "SENT" | "ERROR";

export type UserRole = "user" | "admin";
export type CardKeyStatus = "unused" | "redeemed" | "disabled";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  aiApiKey: string;
  quotaBalance: number;
  quotaExpiresAt: number | null;
  avatarUrl?: string | null;
  avatarVersion?: number | null;
  syncVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

export interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  aiApiKey: string;
  quotaBalance: number;
  quotaExpiresAt: number | null;
  avatarUrl?: string | null;
  avatarVersion?: number | null;
  syncVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

export interface PlanDoc {
  _id: string;
  name: string;
  description?: string | null;
  /** 兑换后一次性充入的额度（token 数）。 */
  quotaTokens: number;
  /** 自兑换时刻（或现有有效期之后）起的有效天数。 */
  validityDays: number;
  /** 展示用价格文案（如 "¥9.9"），不参与任何支付逻辑。 */
  price?: string | null;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CardKeyDoc {
  _id: string;
  code: string;
  planId: string;
  /** 创建卡密时的套餐快照，套餐被删除后卡密仍可兑换。 */
  planName: string;
  quotaTokens: number;
  validityDays: number;
  status: CardKeyStatus;
  note?: string | null;
  createdByUserId: string;
  createdAt: number;
  redeemedByUserId?: string | null;
  redeemedAt?: number | null;
}

export interface RedemptionDoc {
  _id: string;
  userId: string;
  cardKeyId: string;
  cardCode: string;
  planId: string;
  planName: string;
  quotaTokens: number;
  validityDays: number;
  createdAt: number;
}

export interface AiModelDoc {
  _id: string;
  displayName?: string | null;
  /** 消耗倍率：cost = ceil(totalTokens × rate)。 */
  rate: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpstreamDoc {
  _id: string;
  name: string;
  /** OpenAI 兼容根地址（含 /v1），例如 https://api.example.com/v1。 */
  baseUrl: string;
  apiKey: string;
  /** 该上游可服务的模型 ID 列表（对应 ai_models._id）。 */
  models: string[];
  /** 路由优先级，数字越小越优先。 */
  priority: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UsageLogDoc {
  _id: string;
  userId: string;
  modelId: string;
  upstreamId?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 实际扣减的额度。 */
  cost: number;
  stream: boolean;
  createdAt: number;
}

export interface UsageStats {
  requests: number;
  tokens: number;
  cost: number;
}

export interface AgentDoc {
  _id: string;
  userId: string;
  name: string;
  avatarUrl?: string | null;
  avatarVersion?: number | null;
  systemPrompt: string;
  defaultModelId?: string | null;
  temperature: number;
  topP: number;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultMaxTokens: boolean;
  followDefaultReasoningEffort: boolean;
  marketAgentId?: string | null;
  marketAgentVersion?: number | null;
  marketAgentRole?: "publisher" | "importer" | null;
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface MessageEmbed {
  id: string;
  role: MessageRole;
  content: string;
  /**
   * JSON-encoded ContentPart array (text / image). Null or absent for
   * text-only messages and for documents from pre-multimodal clients.
   */
  partsJson?: string | null;
  timestamp: number;
  status: MessageStatus;
  errorMessage?: string | null;
}

export interface ConversationDoc {
  _id: string;
  userId: string;
  agentId: string;
  title: string;
  providerId: string;
  overrideModelId?: string | null;
  overrideTemperature?: number | null;
  overrideTopP?: number | null;
  overrideMaxTokens?: number | null;
  overrideReasoningEffort?: string | null;
  reasoningFormat?: string | null;
  messages: MessageEmbed[];
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface ModelEmbed {
  id: string;
  modelId: string;
  displayName: string;
  isEnabled: boolean;
  createdAt: number;
}

export interface ProviderDoc {
  _id: string;
  userId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelEmbed[];
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface SyncResponse {
  agents: AgentDoc[];
  conversations: ConversationDoc[];
  providers: ProviderDoc[];
  latestVersion: number;
}

export interface UpsertResponse {
  id: string;
  version: number;
}

export interface AvatarUploadResponse {
  url: string | null;
  version: number;
}

export interface AgentUpsertInput {
  id: string;
  name: string;
  // Avatar URLs are server-managed by the avatar endpoints.
  avatarUrl?: string | null;
  systemPrompt: string;
  defaultModelId?: string | null;
  temperature: number;
  topP: number;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultMaxTokens: boolean;
  followDefaultReasoningEffort: boolean;
  marketAgentId?: string | null;
  marketAgentVersion?: number | null;
  marketAgentRole?: "publisher" | "importer" | null;
  createdAt: number;
  updatedAt: number;
}

export interface MarketAgentDoc {
  _id: string;
  ownerUserId: string;
  name: string;
  avatarUrl?: string | null;
  avatarVersion?: number | null;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface MarketAgentInput {
  name: string;
  systemPrompt: string;
  temperature: number;
  topP: number;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
}

export interface ConversationUpsertInput {
  id: string;
  title: string;
  agentId: string;
  providerId: string;
  overrideModelId?: string | null;
  overrideTemperature?: number | null;
  overrideTopP?: number | null;
  overrideMaxTokens?: number | null;
  overrideReasoningEffort?: string | null;
  reasoningFormat?: string | null;
  messages: MessageEmbed[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderUpsertInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelEmbed[];
  createdAt: number;
  updatedAt: number;
}

export interface AdminRecentUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: number;
}

export interface SiteOverview {
  users: {
    total: number;
    admins: number;
    newToday: number;
  };
  usage: {
    today: UsageStats;
    week: UsageStats;
  };
  cards: {
    total: number;
    unused: number;
    redeemed: number;
    disabled: number;
  };
  plans: {
    total: number;
    enabled: number;
  };
  upstreams: {
    total: number;
    enabled: number;
  };
  recentUsers: AdminRecentUser[];
  recentUsage: UsageLogDoc[];
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  role: "user" | "admin";
}
