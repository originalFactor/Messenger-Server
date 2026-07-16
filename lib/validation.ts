import { z } from "zod";

export const entityIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "IDs may only contain letters, numbers, underscores, and hyphens.");

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
}).strict();

export const passwordDeleteSchema = z.object({
  currentPassword: z.string().min(1).max(200),
}).strict();

export const agentSchema = z.object({
  id: entityIdSchema,
  name: z.string().trim().min(1).max(200),
  avatarUrl: z.string().url().nullable().optional(),
  systemPrompt: z.string(),
  defaultModelId: entityIdSchema.nullable().optional(),
  temperature: z.number().finite(),
  topP: z.number().finite(),
  maxTokens: z.number().int().nullable().optional(),
  isDefault: z.boolean(),
  followDefaultSystemPrompt: z.boolean(),
  followDefaultModel: z.boolean(),
  followDefaultTemperature: z.boolean(),
  followDefaultTopP: z.boolean(),
  followDefaultMaxTokens: z.boolean(),
  marketAgentId: entityIdSchema.nullable().optional(),
  marketAgentVersion: z.number().int().nonnegative().nullable().optional(),
  marketAgentRole: z.enum(["publisher", "importer"]).nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const marketAgentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  systemPrompt: z.string().max(50_000),
  temperature: z.number().finite(),
  topP: z.number().finite(),
  maxTokens: z.number().int().nullable().optional(),
}).strict();

export const messageSchema = z.object({
  id: entityIdSchema,
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  timestamp: z.number().int().nonnegative(),
  status: z.enum(["SENDING", "SENT", "ERROR", "sending", "sent", "error"]).transform((value) => value.toUpperCase() as "SENDING" | "SENT" | "ERROR"),
  errorMessage: z.string().nullable().optional(),
}).strict();

export const conversationSchema = z.object({
  id: entityIdSchema,
  title: z.string(),
  agentId: entityIdSchema,
  // A conversation can exist before its agent has a model/provider configured.
  providerId: z.string().max(200),
  overrideModelId: z.string().nullable().optional(),
  overrideTemperature: z.number().finite().nullable().optional(),
  overrideTopP: z.number().finite().nullable().optional(),
  overrideMaxTokens: z.number().int().nullable().optional(),
  messages: z.array(messageSchema).max(10_000),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const modelSchema = z.object({
  id: entityIdSchema,
  modelId: z.string().min(1).max(500),
  displayName: z.string(),
  isEnabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
}).strict();

export const providerSchema = z.object({
  id: entityIdSchema,
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().url().max(2_000),
  apiKey: z.string(),
  models: z.array(modelSchema),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024;

const avatarContentTypes = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

export interface AvatarUpload {
  file: File;
  extension: (typeof avatarContentTypes)[keyof typeof avatarContentTypes];
  contentType: keyof typeof avatarContentTypes;
}

export function getAvatarUpload(formData: FormData): AvatarUpload | null {
  const value = formData.get("file") ?? formData.get("avatar");
  if (!value || typeof value === "string" || typeof value.arrayBuffer !== "function") {
    return null;
  }

  const contentType = value.type as keyof typeof avatarContentTypes;
  const extension = avatarContentTypes[contentType];
  if (!extension || value.size === 0 || value.size > MAX_AVATAR_SIZE_BYTES) {
    return null;
  }

  return { file: value, extension, contentType };
}
