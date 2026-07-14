import { z } from "zod";

const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  avatar: z.string().nullable().optional(),
  systemPrompt: z.string(),
  defaultModelId: z.string().nullable().optional(),
  temperature: z.number(),
  topP: z.number(),
  maxTokens: z.number().int().nullable().optional(),
  isDefault: z.boolean(),
  followDefaultSystemPrompt: z.boolean(),
  followDefaultModel: z.boolean(),
  followDefaultTemperature: z.boolean(),
  followDefaultTopP: z.boolean(),
  followDefaultMaxTokens: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const conversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  providerId: z.string().min(1),
  agentId: z.string().min(1),
  overrideModelId: z.string().nullable().optional(),
  overrideTemperature: z.number().nullable().optional(),
  overrideTopP: z.number().nullable().optional(),
  overrideMaxTokens: z.number().int().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastMessage: z.string().nullable().optional(),
});

const messageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  timestamp: z.number().int(),
  status: z.enum(["SENDING", "SENT", "ERROR"]),
  errorMessage: z.string().nullable().optional(),
});

export const credentialsSchema = z.object({
  email: z.string().email().transform((value: string) => value.trim().toLowerCase()),
  password: z.string().min(8).max(200),
});

export const backupPayloadSchema = z.object({
  schemaVersion: z.number().int().min(1),
  exportedAt: z.number().int(),
  device: z.object({
    platform: z.string().optional(),
    appVersion: z.string().optional(),
    deviceName: z.string().optional(),
  }).optional(),
  providers: z.array(providerSchema),
  agents: z.array(agentSchema),
  conversations: z.array(conversationSchema),
  messages: z.array(messageSchema),
});
