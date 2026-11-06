/*
 * Copyright 2026 originalFactor
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

import type { CatalogModelMetadata } from "@/lib/pi-catalog";
import type { JWTPayload } from "jose";

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus = "SENDING" | "SENT" | "ERROR";

export type UserRole = "user" | "admin";
export type CardKeyStatus = "unused" | "redeemed" | "disabled";

/** 管理端用户视图：不含 passwordHash / aiApiKey 等敏感字段。 */
export interface AdminUserView {
  _id: string;
  email: string;
  /** 邮箱验证时刻；null = 未验证。 */
  emailVerifiedAt: number | null;
  role: UserRole;
  /** 未过期套餐条目的额度之和。 */
  quotaBalance: number;
  /** 未过期条目中最晚的到期时间；quotaUnlimited 时为 null。 */
  quotaExpiresAt: number | null;
  /** 是否持有不限有效期的条目（管理员直接授予）。 */
  quotaUnlimited: boolean;
  /** 未过期套餐条目数。 */
  activeQuotaCount: number;
  createdAt: number;
  lastLoginAt?: number;
}

/**
 * 用户持有的套餐条目：每次兑换 / 管理员授予各产生一条，
 * 额度与有效期独立计算；消耗时按先过期先用扣减。
 */
export interface UserQuotaDoc {
  _id: string;
  userId: string;
  source: "card" | "admin" | "migrated";
  cardKeyId?: string | null;
  planId?: string | null;
  planName?: string | null;
  balance: number;
  /** null = 不限有效期。 */
  expiresAt: number | null;
  createdAt: number;
}

export interface StoredUser {
  id: string;
  email: string;
  /** 用户中心设置的昵称；null = 未设置（展示端回落到邮箱）。 */
  displayName: string | null;
  passwordHash: string;
  /** 邮箱验证通过的时刻；null = 从未验证（SMTP 未配置时注册即为 null）。 */
  emailVerifiedAt: number | null;
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
  /** 昵称；缺失（旧文档）视为未设置。 */
  displayName?: string | null;
  passwordHash: string;
  /** 邮箱验证通过的时刻；缺失（旧文档）视为未验证。 */
  emailVerifiedAt?: number | null;
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

export interface UpstreamModelMeta {
  /** 手选的 pi-catalog 完整键；缺省自动匹配。 */
  catalogModelId?: string | null;
  /** Legacy only: false suppresses old dormant rates; new editors omit this flag. */
  override?: boolean;
  displayName?: string | null;
  inputModalities?: string[] | null;
  reasoning?: boolean | null;
  reasoningEfforts?: string[] | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsTemperature?: boolean | null;
  supportsTopP?: boolean | null;
  supportsPenalties?: boolean | null;
  /** 缓存读取倍率，0 = 不计费；缺省按上游报价 → pi-catalog（无数据按输入价 × 折扣）。 */
  cacheReadRate?: number | null;
  /** 缓存写入倍率，0 = 不计费；缺省按上游报价 → pi-catalog（无数据按缓存读取）。 */
  cacheWriteRate?: number | null;
  /** 输入倍率，0 = 不计费。 */
  inputRate?: number | null;
  /** 输出倍率，0 = 不计费。 */
  outputRate?: number | null;
  /**
   * 长上下文阶梯（整份自定义）：提示总量超过阈值后整次请求按该档计价。
   * 缺省则沿用上游报价 → pi-catalog 的阶梯；不与另一侧逐项混拼。
   */
  tiers?: PricingTier[] | null;
  /**
   * 峰谷配置（整份自定义）：峰值时段按牌价，其余时间乘以谷时系数。
   * 缺省则沿用上游报价 → pi-catalog 的配置。
   */
  timeBased?: PricingSchedule | null;
  /**
   * 模型整体倍率（modelRate）：把上面三种 tokenType 倍率整体再乘一次，
   * 独立于各 tokenType 单价，允许只放大整体倍率。缺省/非法值 = 1（不缩放），显式 0 = 该模型在此上游不计费。
   */
  multiplier?: number | null;
}

/** 长上下文阶梯：阈值（token）与该档的四条腿倍率。 */
export interface PricingTier {
  /** 提示总量阈值；超过（`inputThresholdInclusive` 时为达到）才用本档。 */
  inputThreshold: number;
  /** true = 阈值含等号。缺省 false。 */
  inputThresholdInclusive?: boolean;
  inputRate?: number | null;
  cacheReadRate?: number | null;
  cacheWriteRate?: number | null;
  outputRate?: number | null;
}

/** 峰值时段：UTC 星期（周日 = 0），起始分钟含、结束分钟不含。 */
export interface PricingPeakWindow {
  weekdays: number[];
  startMinute: number;
  endMinute: number;
}

/** 峰谷计费：处于峰值时段按牌价，其余时间乘以 `offPeakMultiplier`。 */
export interface PricingSchedule {
  offPeakMultiplier: number;
  peakWindows: PricingPeakWindow[];
}

/**
 * 上游自己 `/v1/models` 返回的报价（服务端维护，管理员不可手改）：
 * 字段与本服务 `/v1/models` 的 `input_rate` / `cache_read_rate` /
 * `cache_write_rate` / `output_rate` 同构，已经是倍率口径而不是美元价。
 * 未返回或返回 0 的腿逐项回退 pi-catalog；`tiers` / `timeBased` 若返回
 * 则整份覆盖目录的同名配置。
 *
 * 探测/拉取模型列表时刷新；模型从 `models` / `disabledModels` 删除时一并移除。
 */
export interface UpstreamModelPrice {
  inputRate?: number | null;
  cacheReadRate?: number | null;
  cacheWriteRate?: number | null;
  outputRate?: number | null;
  /** 长上下文阶梯（上游原样返回，倍率口径）。 */
  tiers?: PricingTier[] | null;
  /** 峰谷配置（上游原样返回）。 */
  timeBased?: PricingSchedule | null;
  /** 报价的拉取时间（毫秒时间戳），仅用于展示。 */
  fetchedAt?: number | null;
}

/**
 * 全局模型倍率设置（`model_rate_settings` 集合，单文档 `_id = "default"`）。
 * baseModelId 非空时，它的生效 tokenType 倍率即 1x 基准：其余模型的已存
 * 倍率（含覆盖条目）在基准切换时重新归一。
 */
export interface ModelRateSettingsDoc {
  _id: "default";
  /** 基准模型 ID；null = 未选基准，维持 pi-catalog 归一化倍率。 */
  baseModelId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpstreamDoc {
  _id: string;
  name: string;
  /** 上游根地址（含版本段），例如 https://api.example.com/v1 或 https://generativelanguage.googleapis.com/v1beta。 */
  baseUrl: string;
  apiKey: string;
  /**
   * 上游对话协议：`chat`（OpenAI Chat Completions）、`responses`（OpenAI
   * Responses）、`messages`（Anthropic Messages）、`interactions`（Gemini
   * Interactions），或 `auto` = 跟随客户端请求的协议。缺省视为 `auto`。
   */
  apiFormat?: "chat" | "responses" | "messages" | "interactions" | "auto" | null;
  /** 该上游可服务的模型 ID 列表。 */
  models: string[];
  /** 按上游逐字段自定义的模型倍率与能力；空值继承报价/catalog。 */
  modelMeta?: Record<string, UpstreamModelMeta> | null;
  /**
   * 上游 `/v1/models` 自报的模型报价（倍率口径），服务端在探测时刷新；
   * 解析时优先于 pi-catalog，逐字段回退。缺失（旧文档）= 全部回退目录。
   */
  modelPrices?: Record<string, UpstreamModelPrice> | null;
  /** 表中保留但停用的模型 ID：不参与服务，仅用于编辑表单回显。 */
  disabledModels?: string[] | null;
  /**
   * 上游整体倍率（providerRate）：把该上游所有模型的生效 tokenType
   * 倍率整体再乘一次，与 per-model multiplier 叠加生效：
   *   实际倍率 = tokenTypeRate × modelRate × providerRate
   * 缺省/非法值 = 1（不缩放），显式 0 = 该上游所有模型不计费。
   */
  multiplier?: number | null;
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
  /** 未命中缓存的输入 token 数（上游 prompt_tokens − cachedTokens − cacheWriteTokens）。 */
  promptTokens: number;
  completionTokens: number;
  /** 命中的缓存读取 token 数（0 = 无缓存命中）。 */
  cachedTokens: number;
  /** 写入缓存的 token 数（Anthropic 显式计费；其余协议通常为 0）。 */
  cacheWriteTokens?: number;
  /** 完整用量：未缓存输入 + 缓存读取 + 缓存写入 + 输出。 */
  totalTokens: number;
  /** 实际扣减的额度。 */
  cost: number;
  /** 请求耗时（毫秒）；老数据与缺失时为 null，输出 TPS 不可计算。 */
  durationMs: number | null;
  /** 命中长上下文阶梯时的阈值（token）；未命中为 null。 */
  longContextThreshold?: number | null;
  /** 实际套用的峰谷系数（1 = 峰值牌价）。 */
  timeMultiplier?: number | null;
  /** 迁移标记：该记录的 promptTokens 已剔除缓存读取部分（老数据迁移后补写）。 */
  inputExcludesCache?: boolean;
  createdAt: number;
}

/** 运行时日志级别：error = 5xx/未捕获异常；warn = 4xx/降级；info = 正常事件。 */
export type RuntimeLogLevel = "error" | "warn" | "info";

/** 日志来源：业务域标签，用于「日志页」按域筛选。 */
export type RuntimeLogSource =
  | "api"
  | "relay"
  | "auth"
  | "billing"
  | "admin"
  | "sync"
  | "market"
  | "avatar"
  | "storage"
  | "migration";

/**
 * 系统运行日志 JSONL 记录（管理后台「日志页」数据源）。
 * 文件查询按 `(createdAt, _id)` 倒序分页。
 * `level`/`source` 仅用于筛选，`details` 存原始错误/上下文对象，不保证模式稳定。
 */
export interface RuntimeLogDoc {
  _id: string;
  level: RuntimeLogLevel;
  source: RuntimeLogSource;
  /** 触发日志的请求方法（GET/POST…），无法关联时为 null。 */
  method: string | null;
  /** 触发日志的请求路径，脱敏后存储；非 HTTP 来源为 null。 */
  path: string | null;
  /** HTTP 状态码；非 HTTP 来源为 null。 */
  status: number | null;
  /** 人读摘要：错误名 + fallbackMessage 或事件描述。 */
  message: string;
  /** 原始错误/上下文（name/message/stack/cause 或自由结构），不做模式约束。 */
  details: unknown;
  createdAt: number;
}

/** 调用记录明细表展示行：`UsageLogDoc` 展开 + 调用方邮箱 + 上游名称（用于页面/API 共用）。 */
export interface AdminUsageRow extends UsageLogDoc {
  /** 调用方账号：用户邮箱；用户被删除时为 null（页面兜底「—」）。 */
  email: string | null;
  /** 上游名称；`upstreamId` 为空或上游被删时为 null（页面兜底 id 或「—」）。 */
  upstreamName: string | null;
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
  /** Agent 一句话描述（列表/编辑页展示用）。缺省视为空串。 */
  description?: string | null;
  defaultModelId?: string | null;
  temperature: number;
  topP: number;
  temperatureEnabled?: boolean;
  topPEnabled?: boolean;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultFrequencyPenalty?: boolean;
  followDefaultPresencePenalty?: boolean;
  followDefaultMaxTokens: boolean;
  followDefaultReasoningEffort: boolean;
  marketAgentId?: string | null;
  marketAgentVersion?: number | null;
  marketAgentRole?: "publisher" | "importer" | null;
  /** Agent 角色分类：chat=聊天（默认）、title=标题生成。缺省视为 chat。 */
  role?: "chat" | "title" | null;
  /** 客户端工具开关（是否随请求声明内置工具）。缺省视为 false。 */
  toolsEnabled?: boolean | null;
  /** 非默认 Agent 是否整体跟随默认 Agent 的工具配置。缺省视为 false。 */
  toolsFollowDefault?: boolean | null;
  /** 每工具开关（键为工具函数名）。缺省视为默认全开。 */
  toolsConfig?: Record<string, boolean> | null;
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
  overrideFrequencyPenalty?: number | null;
  overridePresencePenalty?: number | null;
  followAgentTemperature?: boolean;
  followAgentTopP?: boolean;
  followAgentFrequencyPenalty?: boolean;
  followAgentPresencePenalty?: boolean;
  overrideMaxTokens?: number | null;
  overrideReasoningEffort?: string | null;
  /** 会话级工具总开关覆盖；缺省 null = 跟随 Agent 生效值。 */
  overrideToolsEnabled?: boolean | null;
  /** 会话级每工具开关覆盖（缺失键 = 开启）；缺省 null = 跟随 Agent。 */
  overrideToolsConfig?: Record<string, boolean> | null;
  /** 会话级 Agent 模式（只读/可写）；缺省 false = 只读。 */
  writable?: boolean | null;
  reasoningFormat?: string | null;
  /** 所属项目 id；缺省/空 = 普通会话（无工作区工具）。 */
  projectId?: string | null;
  /** 80% 上下文自动摘要：折叠摘要、覆盖截止时间戳与最近一次用量记账。 */
  contextSummary?: string | null;
  contextSummaryUntil?: number | null;
  contextTokens?: number | null;
  contextTokensAt?: number | null;
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
  /** 上下文窗口（tokens），0 = 未知/不限。 */
  contextWindow?: number | null;
  /** 相对基准的输入/输出倍率，0 = 免费；缺失 = 未知。 */
  inputRate?: number | null;
  outputRate?: number | null;
  cacheReadRate?: number | null;
  cacheWriteRate?: number | null;
  tiers?: UpstreamModelPrice["tiers"];
  timeBased?: UpstreamModelPrice["timeBased"];
  /** Sparse capabilities supplied by this Provider's Messenger-extended model list. */
  metadata?: Partial<CatalogModelMetadata> | null;
  createdAt: number;
}

export interface ProviderDoc {
  _id: string;
  userId: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** 客户端 Provider 的对话协议；旧文档缺省视为 auto。 */
  apiFormat?: "chat" | "responses" | "messages" | "interactions" | "auto" | null;
  models: ModelEmbed[];
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface ProjectDoc {
  _id: string;
  userId: string;
  name: string;
  /** 项目工作区目录（绝对路径）。 */
  workspace: string;
  /** 拥有该工作区的设备；旧数据与未上报的客户端为 `null`/缺省。 */
  deviceId?: string | null;
  createdAt: number;
  updatedAt: number;
  version: number;
  deleted: boolean;
}

export interface SyncResponse {
  agents: AgentDoc[];
  conversations: ConversationDoc[];
  providers: ProviderDoc[];
  projects: ProjectDoc[];
  /**
   * 客户端应保存为下一次 `since` 的水位线。合并路径按集合上限截断时，
   * 这里是「已交付的最后一条 version」而不是用户当前 syncVersion，
   * 以保证剩余增量仍会在下次同步中被拉到。
   */
  latestVersion: number;
  /** 合并路径命中上限（客户端应改用 `?collection=` 分页拉取）。 */
  truncated?: boolean;
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
  description?: string | null;
  defaultModelId?: string | null;
  temperature?: number | null;
  topP?: number | null;
  temperatureEnabled?: boolean;
  topPEnabled?: boolean;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  maxTokens?: number | null;
  reasoningEffort?: string | null;
  isDefault: boolean;
  followDefaultSystemPrompt: boolean;
  followDefaultModel: boolean;
  followDefaultTemperature: boolean;
  followDefaultTopP: boolean;
  followDefaultFrequencyPenalty?: boolean;
  followDefaultPresencePenalty?: boolean;
  followDefaultMaxTokens: boolean;
  followDefaultReasoningEffort: boolean;
  marketAgentId?: string | null;
  marketAgentVersion?: number | null;
  marketAgentRole?: "publisher" | "importer" | null;
  role?: "chat" | "title" | null;
  toolsEnabled?: boolean | null;
  toolsFollowDefault?: boolean | null;
  toolsConfig?: Record<string, boolean> | null;
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
  overrideFrequencyPenalty?: number | null;
  overridePresencePenalty?: number | null;
  followAgentTemperature?: boolean;
  followAgentTopP?: boolean;
  followAgentFrequencyPenalty?: boolean;
  followAgentPresencePenalty?: boolean;
  overrideMaxTokens?: number | null;
  overrideReasoningEffort?: string | null;
  /** 会话级工具总开关覆盖；缺省 null = 跟随 Agent 生效值。 */
  overrideToolsEnabled?: boolean | null;
  /** 会话级每工具开关覆盖（缺失键 = 开启）；缺省 null = 跟随 Agent。 */
  overrideToolsConfig?: Record<string, boolean> | null;
  /** 会话级 Agent 模式（只读/可写）；缺省 false = 只读。 */
  writable?: boolean | null;
  /** 所属项目 id；缺省/空 = 普通会话（无工作区工具）。 */
  projectId?: string | null;
  reasoningFormat?: string | null;
  /** 80% 上下文自动摘要：折叠摘要、覆盖截止时间戳与最近一次用量记账。 */
  contextSummary?: string | null;
  contextSummaryUntil?: number | null;
  contextTokens?: number | null;
  contextTokensAt?: number | null;
  messages: MessageEmbed[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderUpsertInput {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat?: "chat" | "responses" | "messages" | "interactions" | "auto";
  models: ModelEmbed[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectUpsertInput {
  id: string;
  name: string;
  workspace: string;
  deviceId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdminRecentUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: number;
}

/** Messenger Sync 数据概览：活跃（未删除）同步实体计数 + 最近同步时间。 */
export interface SyncSummary {
  agents: number;
  conversations: number;
  providers: number;
  /** 活跃会话内嵌的消息总数。 */
  messages: number;
  lastSyncAt: number | null;
}

/** 全站 Sync 概览：在 SyncSummary 基础上增加有同步数据的用户数。 */
export interface SiteSyncOverview extends SyncSummary {
  syncUsers: number;
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
}

/**
 * 服务端会话记录（`user_sessions`）。
 *
 * 会话是**同步进度账本**，不是凭证黑名单：`syncCursor` 记录该会话已完整
 * 拉取到的 `syncVersion`，服务端据此判断哪些实体墓碑已无人需要。会话本身
 * 不留墓碑——注销或过期即硬删除，行不存在就是无效会话。
 */
export interface UserSessionDoc {
  /** 会话 ID，同时写进 JWT 的 `sid` claim。 */
  _id: string;
  userId: string;
  createdAt: number;
  /** 最近一次成功校验的时间（写回有 1 小时节流）。 */
  lastSeenAt: number;
  /** 到期时刻，Cookie / JWT / 本字段三者共用同一个 30 天常量。 */
  expiresAt: Date;
  /**
   * 该会话已完整应用的 `syncVersion`（增量拉取的 `since` 下界）。
   * 0 = 尚未完成过一次同步，本地状态未知，会阻塞墓碑清理。
   */
  syncCursor: number;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionClaims extends JWTPayload {
  sub: string;
  email?: string;
  role: "user" | "admin";
  /** 服务端会话 ID；缺失即改造前签发的旧 token，一律失效。 */
  sid?: string;
}
