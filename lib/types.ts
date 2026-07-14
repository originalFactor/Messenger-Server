export interface ProviderBackupRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentBackupRecord {
  id: string;
  name: string;
  avatar?: string | null;
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

export interface ModelBackupRecord {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  isEnabled: boolean;
  createdAt: number;
}

export interface ConversationBackupRecord {
  id: string;
  title: string;
  providerId: string;
  agentId: string;
  overrideModelId?: string | null;
  overrideTemperature?: number | null;
  overrideTopP?: number | null;
  overrideMaxTokens?: number | null;
  createdAt: number;
  updatedAt: number;
  lastMessage?: string | null;
}

export type BackupMessageRole = "system" | "user" | "assistant" | "tool";
export type BackupMessageStatus = "SENDING" | "SENT" | "ERROR";

export interface MessageBackupRecord {
  id: string;
  conversationId: string;
  role: BackupMessageRole;
  content: string;
  timestamp: number;
  status: BackupMessageStatus;
  errorMessage?: string | null;
}

export interface MessengerBackupPayload {
  schemaVersion: number;
  exportedAt: number;
  device?: {
    platform?: string;
    appVersion?: string;
    deviceName?: string;
  };
  providers: ProviderBackupRecord[];
  models: ModelBackupRecord[];
  agents: AgentBackupRecord[];
  conversations: ConversationBackupRecord[];
  messages: MessageBackupRecord[];
}

export interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
}

export interface UserIndexEntry {
  id: string;
  email: string;
  createdAt: number;
  updatedAt: number;
  lastBackupAt?: number;
}

export interface BackupManifest {
  userId: string;
  version: number;
  schemaVersion: number;
  uploadedAt: number;
  blobPath: string;
  blobUrl: string;
  sizeBytes: number;
  checksumSha256: string;
  recordCounts: {
    providers: number;
    models: number;
    agents: number;
    conversations: number;
    messages: number;
  };
  device?: MessengerBackupPayload["device"];
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  role: "user" | "admin";
}
import type { JWTPayload } from "jose";
