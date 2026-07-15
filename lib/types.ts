import type { JWTPayload } from "jose";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus = "SENDING" | "SENT" | "ERROR";

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  avatarUrl?: string | null;
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
  systemPrompt: string;
  defaultModelId?: string | null;
  temperature: number;
  topP: number;
  maxTokens?: number | null;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultMaxTokens: boolean;
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface MessageEmbed {
  id: string;
  role: MessageRole;
  content: string;
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
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultMaxTokens: boolean;
  createdAt: number;
  updatedAt: number;
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
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  role: "user" | "admin";
}
