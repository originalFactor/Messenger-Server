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

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
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
  avatarUrl?: string | null;
  avatarVersion?: number | null;
  syncVersion: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
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

export interface CollectionStats {
  count: number;
  latestUpdatedAt: number | null;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  syncVersion: number;
}

export interface AdminDashboard {
  users: AdminUserSummary[];
  stats: {
    users: CollectionStats;
    agents: CollectionStats;
    conversations: CollectionStats;
    providers: CollectionStats;
  };
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  role: "user" | "admin";
}
