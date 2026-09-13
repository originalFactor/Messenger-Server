# Messenger Server API

Messenger `server/` 是一个独立的 Next.js (App Router) SaaS 服务，提供官网、注册登录、网页控制台、账号云同步、卡密套餐计费与内置 AI API（上游模型中转），可部署在 Vercel 或任意自托管 Node 环境。所有业务数据存于 MongoDB（需为副本集），头像文件存于可插拔 Blob 存储层（Vercel Blob 后端或自托管文件系统后端）。

- **运行时**: Node.js ≥ 20，Next.js 15.4
- **路由运行时**: 所有触碰 MongoDB 或 Blob 的路由均声明 `export const runtime = "nodejs"`
- **包管理**: pnpm
- **基类**: TypeScript + Zod 校验

本文档对应 `app/api/**` 与 `app/v1/**` 下全部 33 个路由处理器。如需了解部署、环境变量与本地开发，参见 [`README.md`](./README.md) 与 [`AGENTS.md`](./AGENTS.md)。

---

## 目录

- [通用约定](#通用约定)
  - [Base URL](#base-url)
  - [认证与 Cookie](#认证与-cookie)
  - [请求与响应格式](#请求与响应格式)
  - [错误响应](#错误响应)
  - [ID 与校验规则](#id-与校验规则)
- [端点速查表](#端点速查表)
- [认证 API](#认证-api)
- [账户 API](#账户-api)
- [控制台 API（用户）](#控制台-api用户)
- [管理 API（管理员）](#管理-api管理员)
- [公开 API](#公开-api)
- [AI API（OpenAI 兼容代理）](#ai-apiopenai-兼容代理)
- [实体同步 API](#实体同步-api)
- [增量同步 API](#增量同步-api)
- [头像 API](#头像-api)
- [Agent 市场 API](#agent-市场-api)
- [数据模型](#数据模型)
- [错误码参考](#错误码参考)

---

## 通用约定

### Base URL

由环境变量 `APP_BASE_URL` 决定，默认 `http://localhost:3000`。所有响应中出现的 `avatarUrl`、`url` 字段都会通过 `appUrl()` 重写为完整绝对地址（例如 `http://localhost:3000/api/avatars/user`）。

### 认证与 Cookie / AI API Key

管理员与普通用户共用同一套 JWT 会话（HS256、HttpOnly + SameSite=Lax Cookie）：

| 凭据 | 载体 | 用途 | 有效期 | 签发者 |
| --- | --- | --- | --- | --- |
| 用户会话 | `messenger_session` Cookie | 网页控制台、`/api/auth/*`、`/api/console/*`、实体同步、头像、市场 | 30 天 | `POST /api/auth/register`、`POST /api/auth/login` |
| AI API Key | `Authorization: Bearer sk-…` | `/v1/models`、`/v1/chat/completions`（OpenAI 兼容代理） | 长期（可重置） | 注册时生成；`POST /api/console/api-key` 重置 |

JWT Claims 结构（管理员与用户的会话格式相同，`role` 区分权限）：

```ts
interface SessionClaims {
  sub: string;       // 用户 ID
  email?: string;
  role: "user" | "admin";
}
```

鉴权行为：

- **首个注册用户自动晋升为管理员**（由注册事务保证全局唯一；对改造前的存量部署，服务启动迁移会把最早注册用户提升为 admin 并写入 `system_bootstrap` 标记）。
- 除注册/登录/登出、`GET /api/plans` 与 `/v1/*`（走 API Key）外，所有 `/api/**` 路由都要求有效会话。
- `/api/admin/*` 在会话之外**再查数据库校验 `role === "admin"`**（`requireAdminUser()`），旧 token 提权无效；未通过返回 `403 Forbidden.`。
- 缺失/过期的用户会话统一返回 `401 Unauthorized.`；无效的 AI API Key 返回 OpenAI 格式的 `401` 错误体。
- `secure` 标志仅在 `NODE_ENV=production` 时启用，本地开发走 HTTP。

### 请求与响应格式

- 请求体：除头像 PUT 使用 `multipart/form-data` 外，所有请求体为 `application/json`。
- 成功响应：均为 JSON，HTTP 状态码见各端点说明。无显式状态码时为 `200`。
- 成功响应统一通过 `jsonOk(data, status?, headers?)` 返回；失败通过 `jsonError(message, status)` 返回。
- 所有时间戳为 Unix 毫秒（`number`）。
- 凡是返回头像相关字段的端点，`avatarUrl` 会重写为可认证访问的代理地址（如 `/api/avatars/user`），原始 Blob 私有 URL 不会暴露给客户端。

### 错误响应

失败响应统一格式：

```json
{ "error": "描述信息" }
```

错误到 HTTP 状态码的映射（见 [`lib/route-errors.ts`](./lib/route-errors.ts)）：

| 错误类型 | 状态码 | 触发场景 |
| --- | --- | --- |
| `NotFoundError` | 404 | 实体不存在 |
| `ConflictError` | 409 | 版本/锁冲突 |
| `AvatarLockError` | 409 | 头像锁竞争 |
| MongoDB 重复键 (code 11000) | 409 | 唯一约束冲突 |
| Zod 校验失败 | 400 | 请求体不合法 |
| 未认证 | 401 | 无有效会话 |
| 其他未捕获错误 | 500 | 服务端故障（详情写入服务端日志） |

### ID 与校验规则

所有路径参数 ID 与实体 `id` 字段必须满足 [`entityIdSchema`](./lib/validation.ts)：

- 长度 1–200
- 仅允许 `A–Z`、`a–z`、`0–9`、`_`、`-`

非法 ID 返回 `400 Invalid ... ID.`。

---

## 端点速查表

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | 无 | 注册账号（首个用户晋升管理员）并签发会话 |
| POST | `/api/auth/login` | 无 | 登录并签发会话 |
| POST | `/api/auth/logout` | 无 | 注销当前用户会话 |
| GET | `/api/auth/me` | 用户 | 获取当前用户信息（含角色/额度/API Key） |
| PUT | `/api/auth/password` | 用户 | 修改密码 |
| DELETE | `/api/auth/account` | 用户 | 永久注销账户 |
| GET | `/api/console/overview` | 用户 | 控制台概览（额度 + 用量） |
| POST | `/api/console/cards/preview` | 用户 | 兑换前查询卡密信息 |
| POST | `/api/console/redeem` | 用户 | 兑换卡密 |
| GET | `/api/console/redemptions` | 用户 | 历史兑换记录 |
| POST | `/api/console/api-key` | 用户 | 重置 AI API Key |
| GET | `/api/admin/overview` | 管理员 | 全站概览统计 |
| GET | `/api/admin/plans` | 管理员 | 套餐列表 |
| POST | `/api/admin/plans` | 管理员 | 新建套餐 |
| PUT | `/api/admin/plans/{id}` | 管理员 | 更新套餐 |
| DELETE | `/api/admin/plans/{id}` | 管理员 | 删除套餐 |
| GET | `/api/admin/cards` | 管理员 | 卡密列表（分页/筛选） |
| POST | `/api/admin/cards` | 管理员 | 批量开卡 |
| PATCH | `/api/admin/cards/{id}` | 管理员 | 停用未用卡密 |
| DELETE | `/api/admin/cards/{id}` | 管理员 | 删除未用/停用卡密 |
| GET | `/api/admin/models/metadata` | 管理员 | models.dev 模型元数据（上下文/输入输出倍率） |
| GET | `/api/admin/upstreams` | 管理员 | 上游列表 |
| POST | `/api/admin/upstreams` | 管理员 | 新增上游 |
| PUT | `/api/admin/upstreams/{id}` | 管理员 | 更新上游 |
| DELETE | `/api/admin/upstreams/{id}` | 管理员 | 删除上游 |
| POST | `/api/admin/upstreams/probe` | 管理员 | 直接探测上游模型列表（无需先保存） |
| POST | `/api/admin/upstreams/{id}/probe` | 管理员 | 探测已保存上游的模型列表 |
| POST | `/api/admin/upstreams/test` | 管理员 | 测试上游单个模型（最小 chat completion） |
| GET | `/api/plans` | 无 | 公开套餐列表（官网定价） |
| GET | `/v1/models` | AI API Key | OpenAI 兼容模型列表 |
| POST | `/v1/chat/completions` | AI API Key | OpenAI 兼容对话（流式/非流式，扣额度） |
| PUT | `/api/agents/{id}` | 用户 | 新增/更新 Agent |
| DELETE | `/api/agents/{id}` | 用户 | 软删除 Agent |
| PUT | `/api/conversations/{id}` | 用户 | 新增/更新会话 |
| DELETE | `/api/conversations/{id}` | 用户 | 软删除会话 |
| PUT | `/api/providers/{id}` | 用户 | 新增/更新 Provider |
| DELETE | `/api/providers/{id}` | 用户 | 软删除 Provider |
| GET | `/api/sync` | 用户 | 拉取增量同步数据 |
| GET | `/api/avatars/user` | 用户 | 读取当前用户头像 |
| PUT | `/api/avatars/user` | 用户 | 上传/替换用户头像 |
| DELETE | `/api/avatars/user` | 用户 | 删除用户头像 |
| GET | `/api/avatars/agents/{agentId}` | 用户 | 读取 Agent 头像 |
| PUT | `/api/avatars/agents/{agentId}` | 用户 | 上传/替换 Agent 头像 |
| DELETE | `/api/avatars/agents/{agentId}` | 用户 | 删除 Agent 头像 |
| GET | `/api/market/agents` | 用户 | 列出市场 Agent |
| POST | `/api/market/agents` | 用户 | 发布市场 Agent |
| GET | `/api/market/agents/{id}` | 用户 | 获取单个市场 Agent |
| PUT | `/api/market/agents/{id}` | 用户（仅所有者） | 更新市场 Agent |
| DELETE | `/api/market/agents/{id}` | 用户（仅所有者） | 下架市场 Agent |
| GET | `/api/market/agents/{id}/avatar` | 用户 | 读取市场 Agent 头像 |
| PUT | `/api/market/agents/{id}/avatar` | 用户（仅所有者） | 上传/替换市场头像 |
| DELETE | `/api/market/agents/{id}/avatar` | 用户（仅所有者） | 删除市场头像 |

> 网页端：`/` 为官网首页，`/login`、`/register` 为登录注册页，`/console` 为用户与管理员共用的控制台（管理员侧边栏多出「管理功能区」）。

---

## 认证 API

### POST /api/auth/register

注册新账号，自动签发用户会话，并在同一 MongoDB 事务中创建默认 Agent（名为「默认 Agent」、`systemPrompt: "You are a helpful assistant."`、`temperature: 0.7`、`topP: 1`、`isDefault: true`）。

- 鉴权：无
- 请求体：`credentialsSchema`

```jsonc
{
  "email": "user@example.com",   // 会被 trim + 转小写 + email 校验
  "password": "至少8位"           // 8–200 字符
}
```

- 响应 `201`：

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "user",              // 全站无管理员时为 "admin"（首个注册用户）
    "avatarUrl": null,
    "avatarVersion": null,
    "syncVersion": 1,            // 默认 Agent 的写入把水位线从 0 推到 1
    "createdAt": 1700000000000
  }
}
```

- 错误：
  - `400 Invalid registration payload.`
  - `409 An account with this email already exists.`（先查后写，捕获唯一键冲突兜底）

### POST /api/auth/login

凭邮箱密码登录，更新 `lastLoginAt` 并签发会话。

- 鉴权：无
- 请求体：`credentialsSchema`（同上）
- 响应 `200`：

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "user",
    "avatarUrl": "http://localhost:3000/api/avatars/user",  // 仅在已设头像时
    "avatarVersion": 1700000000000,
    "syncVersion": 42,
    "lastLoginAt": 1700000000000
  }
}
```

- 错误：
  - `400 Invalid login payload.`
  - `401 Invalid email or password.`（用户不存在或密码错误均返回同一文案以防探测）

### POST /api/auth/logout

清除用户会话 Cookie。无论是否登录都返回成功。

- 鉴权：无（操作幂等）
- 请求体：无
- 响应 `200`：`{ "success": true }`

---

## 账户 API

### GET /api/auth/me

返回当前登录用户的完整资料。

- 鉴权：用户会话
- 响应 `200`：

```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "role": "user",
    "aiApiKey": "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "quotaBalance": 98000,
    "quotaExpiresAt": 1702588800000,
    "avatarUrl": "http://localhost:3000/api/avatars/user",
    "avatarVersion": 1700000000000,
    "syncVersion": 42,
    "createdAt": 1700000000000,
    "updatedAt": 1700000000000,
    "lastLoginAt": 1700000000000
  }
}
```

- `aiApiKey`：用户级 AI API Key，调用 `/v1/*` 时作为 Bearer Token；`POST /api/console/api-key` 可重置。
- `quotaBalance` / `quotaExpiresAt`：剩余额度（整数）与有效期；`quotaExpiresAt` 为 `null` 表示从未兑换。

- 错误：`401 Unauthorized.`、`404 User not found.`（账号已被删但 Cookie 未过期）

### PUT /api/auth/password

修改当前账户密码。

- 鉴权：用户会话
- 请求体：`passwordChangeSchema`（strict，多余字段会被拒）

```json
{
  "currentPassword": "原密码",
  "newPassword": "新密码（8–200 位）"
}
```

- 响应 `200`：`{ "success": true }`
- 错误：
  - `400 Invalid password change payload.`
  - `400 The new password must be different.`
  - `401 Unauthorized.`
  - `401 The current password is incorrect.`
  - `404 User not found.`

### DELETE /api/auth/account

永久注销账户。在同一存储事务内删除该用户的所有 `agents`、`conversations`、`providers`、`market_agents`、`redemptions`、`usage_logs` 文档，再异步清理三类头像 Blob，最后清除会话 Cookie。

- 鉴权：用户会话
- 请求体：`passwordDeleteSchema`

```json
{ "currentPassword": "当前密码" }
```

- 响应 `200`：`{ "success": true }`
- 错误：
  - `400 Current password is required.`
  - `401 Unauthorized.` / `401 The current password is incorrect.`
  - 若用户已不存在但仍提供了正确密码：直接清 Cookie 返回 `200`。
  - 头像 Blob 删除失败仅记录服务端日志，不影响响应（账户数据已被删除）。

> 注意：此操作不可恢复。被删账户关联的 Agent 市场 entry 也会一并下架。

---

## 控制台 API（用户）

用户功能区（概览、财务）与 AI API Key 管理端点。鉴权为用户会话 Cookie，管理员同样可用。

### GET /api/console/overview

控制台「概览」页数据。

- 鉴权：用户会话
- 响应 `200`：

```jsonc
{
  "quota": {
    "balance": 98000,
    "expiresAt": 1702588800000,
    "available": true,
    "reason": null            // 不可用时为 "no_quota" | "expired"
  },
  "usage": {
    "today": { "requests": 12, "tokens": 45231, "cost": 45231 }  // 近 24 小时
  },
  "recentUsage": [ /* UsageLogDoc[]，最近 10 条 */ ]
}
```

### POST /api/console/cards/preview

兑换前查询卡密信息（卡内嵌创建时的套餐快照），不消费卡密。

- 鉴权：用户会话
- 请求体：`{ "code": "MS-XXXXX-XXXXX-XXXXX" }`
- 响应 `200`：

```jsonc
{
  "card": {
    "code": "MS-XXXXX-XXXXX-XXXXX",
    "planName": "入门套餐",
    "quotaTokens": 100000,
    "validityDays": 30
  }
}
```

- 错误：`400 请输入有效的卡密。`、`404 卡密不存在，请检查输入是否正确。`、`409 该卡密已被使用。` / `该卡密已被停用。`

### POST /api/console/redeem

兑换卡密。原子占卡（`unused → redeemed`）+ 额度累加 + 有效期顺延在同一事务内完成。

- 鉴权：用户会话
- 请求体：

```json
{ "code": "MS-XXXXX-XXXXX-XXXXX" }
```

- 响应 `200`：

```jsonc
{
  "redemption": {
    "cardCode": "MS-XXXXX-XXXXX-XXXXX",
    "planName": "入门套餐",
    "quotaTokens": 100000,
    "validityDays": 30,
    "redeemedAt": 1700000000000
  },
  "quota": { "balance": 198000, "expiresAt": 1705171200000 }
}
```

- 错误：`400 请输入有效的卡密。`、`404 卡密不存在，请检查输入是否正确。`、`409 该卡密已被使用。` / `该卡密已被停用。`

### GET /api/console/redemptions

- 鉴权：用户会话
- 响应 `200`：`{ "redemptions": [ /* RedemptionDoc[]，最近 50 条，createdAt 降序 */ ] }`

### POST /api/console/api-key

重置 AI API Key。旧 Key 立即失效。

- 鉴权：用户会话
- 响应 `200`：`{ "aiApiKey": "sk-…新的 Key…" }`

---

## 管理 API（管理员）

管理员功能区端点。鉴权为用户会话 + 数据库 `role === "admin"` 校验（`requireAdminUser()`），未通过返回 `403 Forbidden.`。

### GET /api/admin/overview

全站概览统计（用户、近 24h/7 天用量、卡密、套餐、上游、最新注册用户与全站近期调用）。

### GET|POST /api/admin/plans、PUT|DELETE /api/admin/plans/{id}

套餐 CRUD。请求体（`planInputSchema`，strict）：

```jsonc
{
  "name": "入门套餐",
  "description": "适合轻度使用",       // 可选
  "quotaTokens": 100000,               // 兑换后一次性充入的额度
  "validityDays": 30,                  // 有效期天数
  "price": "¥9.9",                     // 展示文案，可选
  "enabled": true,
  "sortOrder": 0
}
```

删除套餐为硬删除；已发出的卡密内嵌套餐快照（名称/额度/天数），仍可正常兑换。

### GET|POST /api/admin/cards、PATCH|DELETE /api/admin/cards/{id}

- `GET`：查询参数 `status`（`unused|redeemed|disabled`，可选）、`planId`（可选）、`cursor`、`limit`（默认 50，上限 200）。响应 `{ cards, hasMore, nextCursor }`。
- `POST`：批量开卡，请求体 `{ "planId": "…", "count": 10, "note": null }`（count 1–500）；响应 `201` `{ "cards": [CardKeyDoc…] }` —— 卡密明文仅在生成时完整返回/落库，请提示管理员立即保存。
- `PATCH`：仅未用卡可停用，请求体 `{ "status": "disabled" }`。
- `DELETE`：仅未用/停用卡可删除；已兑换卡保留作对账凭据。

### GET /api/admin/models/metadata

返回 models.dev（`models.json` + `api.json`）合并的模型元数据，实例内存缓存 24 小时；models.dev 不可用时返回空映射。

- 倍率以 `deepseek/deepseek-v4.1-flash` 的成本为基准归一化（基准恰为 1.0）。
- 响应 `200`：`{ "metadata": { "gpt-4o": { "contextWindow": 128000, "inputRate": 16.6667, "outputRate": 16.6667 } } }`
- 供「更新元数据」入口与上游元数据展示使用。

### GET|POST /api/admin/upstreams、PUT|DELETE /api/admin/upstreams/{id}、POST /api/admin/upstreams/{id}/probe

上游模型服务管理。请求体（`upstreamInputSchema`，strict）：

```jsonc
{
  "name": "主上游",
  "baseUrl": "https://api.example.com/v1",   // OpenAI 兼容根地址（含 /v1）
  "apiKey": "上游密钥",
  "models": ["gpt-4o", "deepseek-chat"],     // 可服务的模型 ID
  "modelMeta": {                              // 按上游自定义的模型元数据（按模型粒度）
    "gpt-4o": { "override": true, "contextWindow": 128000, "inputRate": 16.6667, "outputRate": 16.6667 },
    "deepseek-chat": { "override": false }
  },
  "priority": 0,                              // 越小越优先；同模型多上游自动故障转移
  "enabled": true
}
```

`POST /api/admin/upstreams/probe`：直探模式 —— 请求体 `{ "baseUrl": "https://api.example.com/v1", "apiKey": "…" }`，不要求上游已保存，供「新增/编辑上游」表单直接拉取模型列表；与 `{id}/probe` 共享 `lib/upstream-probe.ts` 实现，连接失败返回 `502`。两条探测路由的响应均内联 models.dev 的上下文数据：`{ "models": ["…"], "contextSizes": { "gpt-4o": 128000 } }`。

`POST /api/admin/upstreams/test`：对单个上游模型发一次最小 chat completion（`"Hi"` + `max_tokens: 16`，30s 超时）。请求体 `{ "baseUrl": "…", "apiKey": "…", "model": "…" }`；响应 `200` 为 `{ "model": "…", "latencyMs": 832, "reply": "…" }`，失败返回上游的 `error.message`（`502`）。供「新增/编辑上游」表单的逐模型测试与整体测试（整体测试自动选已选模型中输入+输出倍率之和最低者）。

### GET /api/admin/models/metadata

返回 models.dev（`https://models.dev/models.json`）的模型元数据映射，实例内存缓存 24 小时；models.dev 不可用时返回空映射。

- 响应 `200`：`{ "metadata": { "gpt-4o": { "contextWindow": 128000 }, "…": {} } }` —— 完整 `vendor/model` 键与 `/` 后的裸 ID 均可命中。

---

## 公开 API

### GET /api/plans

官网定价区使用的公开套餐列表，未登录可访问。

- 响应 `200`：

```jsonc
{
  "plans": [
    { "id": "uuid", "name": "入门套餐", "description": null, "quotaTokens": 100000,
      "validityDays": 30, "price": "¥9.9", "sortOrder": 0 }
  ]
}
```

---

## AI API（OpenAI 兼容代理）

`/v1/*` 是面向用户 API Key（`Authorization: Bearer sk-…`）的 OpenAI 兼容代理。可用模型 = 所有启用上游可服务模型的并集；额度在响应完成后按 `ceil(promptTokens × 输入倍率 + completionTokens × 输出倍率)` 扣减（失败不扣费；上游未返回 usage 时按字符长度估算并记入 `usage_logs`）。元数据解析（按模型）：该模型的 `modelMeta.override` 开启时用其自定义值（缺失字段回退 models.dev），关闭时直接用 models.dev 元数据；无数据置零 —— contextWindow 0 = 不限制，倍率 0 = 不计费（双倍率为 0 时本条调用免费）。

### GET /v1/models

```json
{ "object": "list", "data": [ { "id": "gpt-4o", "object": "model", "created": 1700000000, "owned_by": "messenger-cloud" } ] }
```

### POST /v1/chat/completions

标准的 OpenAI Chat Completions 请求/响应。流式请求会强制注入 `stream_options: {"include_usage": true}` 并将上游 SSE 字节原样透传。同模型配置多个启用上游时按 `priority` 升序故障转移（连接失败或 5xx 切换下一个；4xx 原样透传给调用方）。

- 错误体为 OpenAI 格式：

```jsonc
// 401
{ "error": { "message": "Invalid API key.", "type": "authentication_error", "code": "invalid_api_key" } }
// 402 —— 额度耗尽 / 套餐过期
{ "error": { "message": "Insufficient quota. Redeem a card key to top up.", "type": "insufficient_quota" } }
// 404
{ "error": { "message": "Model 'gpt-4o' is not available.", "type": "invalid_request_error", "code": "model_not_found" } }
// 502 —— 全部上游不可用
{ "error": { "message": "Upstream model service is unavailable.", "type": "api_error" } }
```

---

## 实体同步 API

实体类端点（`agents`、`conversations`、`providers`）遵循统一模式：

- **PUT 用于 upsert**：路径中的 `{id}` 必须与请求体 `id` 一致，否则 `400`。
- **DELETE 用于软删除**：仅置 `deleted: true`，墓碑保留以供增量同步。
- **请求体不含服务端管理字段**：客户端不要传 `version`、`deleted`、`userId`。
- **成功响应**：`{ "id": "...", "version": <新的实体版本号> }`。
- **版本号语义**：每次写入在同一个 MongoDB 事务内 `$inc` 用户 `syncVersion` 并把该值盖到实体 `version` 上，保证 `version` 单调递增且与水位线一致。

### PUT /api/agents/{id}

新增或更新 Agent。会触发头像相关字段的服务端管理（`avatarUrl` 由头像端点维护，但 PUT 接受客户端传入以保留历史快照）。

- 鉴权：用户会话
- 请求体：`agentSchema`（strict）

```jsonc
{
  "id": "agent-uuid",
  "name": "我的助手",
  "avatarUrl": null,                       // 可选；服务端管理
  "systemPrompt": "You are a helpful assistant.",
  "defaultModelId": "model-uuid",           // 可选，可为 null
  "temperature": 0.7,
  "topP": 1,
  "maxTokens": 4096,                        // 可选，可为 null
  "reasoningEffort": "medium",              // 可选，可为 null
  "isDefault": false,
  "followDefaultSystemPrompt": false,
  "followDefaultModel": false,
  "followDefaultTemperature": false,
  "followDefaultTopP": false,
  "followDefaultMaxTokens": false,
  "followDefaultReasoningEffort": false,
  "marketAgentId": null,                    // 可选；指向已导入的市场 Agent
  "marketAgentVersion": null,               // 可选
  "marketAgentRole": "publisher",           // 可选："publisher" | "importer" | null
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

- 响应 `200`：`{ "id": "agent-uuid", "version": 43 }`
- 错误：
  - `400 Invalid agent ID.` / `400 Invalid agent payload.` / `400 The agent ID must match the request path.`
  - `401 Unauthorized.`
  - `409`（并发/唯一约束冲突，例如部分唯一索引保护「每用户一个默认 Agent」）
  - `500 Unable to save the agent.`

### DELETE /api/agents/{id}

软删除 Agent 并同时清理其头像 Blob。删除在头像锁保护下完成，避免与新头像写入竞态。

- 鉴权：用户会话
- 响应 `200`：`{ "id": "agent-uuid", "version": 44 }`
- 错误：`400`、`401`、`404 Agent not found.`、`409`（锁竞争）、`500 Unable to delete the agent.`

### PUT /api/conversations/{id}

新增或更新会话。会话内嵌完整的消息数组（上限 10 000 条）。

- 鉴权：用户会话
- 请求体：`conversationSchema`（strict）

```jsonc
{
  "id": "conv-uuid",
  "title": "新对话",
  "agentId": "agent-uuid",
  "providerId": "provider-uuid",              // 字符串，最长 200；允许尚未配置 provider
  "overrideModelId": null,                     // 可选
  "overrideTemperature": 0.9,                 // 可选
  "overrideTopP": 0.95,                        // 可选
  "overrideMaxTokens": 2048,                   // 可选
  "overrideReasoningEffort": "low",            // 可选
  "reasoningFormat": "parsed",                 // 可选
  "messages": [
    {
      "id": "msg-uuid",
      "role": "user",                          // "system" | "user" | "assistant" | "tool"
      "content": "你好",
      "partsJson": null,                       // 多模态 ContentPart 的 JSON 字符串；纯文本为 null（结构见下方 MessageEmbed 说明）
      "timestamp": 1700000000000,
      "status": "SENT",                        // 接受大小写两种；服务端统一转大写
      "errorMessage": null                    // 可选
    }
  ],
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

- 响应 `200`：`{ "id": "conv-uuid", "version": 45 }`
- 错误：`400 Invalid conversation ID.` / `400 Invalid conversation payload.` / `400 The conversation ID must match the request path.` / `401` / `500 Unable to save the conversation.`

> `messages[].status` 在 Zod 中通过 `.transform()` 统一为大写枚举 `SENDING | SENT | ERROR`，客户端传小写也可。

> **多模态图片同步**：图片不走独立的上传端点，而是内嵌在 `messages[].partsJson` 字符串中随会话文档一起 PUT/同步。`partsJson` 是一个 JSON 数组字符串，元素为 `{"type":"text","text":"..."}` 或 `{"type":"image","dataUri":"data:image/png;base64,...","localPath":"/data/user/0/.../chat_images/xxx.png"}`。`dataUri` 内嵌完整 base64 图片字节（客户端发送前已压缩到最长边 1568px），`localPath` 是发送方设备的私有路径——服务端将整个字符串原样存储、原样回传，**不得**解析、裁剪或重排序；拉取方客户端负责在本地文件缺失时用 `dataUri` 解码重建本地副本。

### DELETE /api/conversations/{id}

软删除会话。删除后会话仅保留墓碑字段供同步。

- 鉴权：用户会话
- 响应 `200`：`{ "id": "conv-uuid", "version": 46 }`
- 错误：`400`、`401`、`404`、`500 Unable to delete the conversation.`

### PUT /api/providers/{id}

新增或更新 Provider。Provider 内嵌完整的模型列表。

- 鉴权：用户会话
- 请求体：`providerSchema`（strict）

```jsonc
{
  "id": "provider-uuid",
  "name": "OpenAI",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "models": [
    {
      "id": "model-uuid",
      "modelId": "gpt-4o",
      "displayName": "GPT-4o",
      "isEnabled": true,
      "createdAt": 1700000000000
    }
  ],
  "createdAt": 1700000000000,
  "updatedAt": 1700000000000
}
```

- 响应 `200`：`{ "id": "provider-uuid", "version": 47 }`
- 错误：`400 Invalid provider ID.` / `400 Invalid provider payload.` / `400 The provider ID must match the request path.` / `401` / `500 Unable to save the provider.`

> `apiKey` 会原样存入 MongoDB，客户端需自行负责密钥安全；该字段从不通过同步响应回传给其他设备之外的渠道，但任何持有该用户会话的设备都能拿到。

### DELETE /api/providers/{id}

软删除 Provider。

- 鉴权：用户会话
- 响应 `200`：`{ "id": "provider-uuid", "version": 48 }`
- 错误：`400`、`401`、`404`、`500 Unable to delete the provider.`

---

## 增量同步 API

### GET /api/sync

拉取自某个版本以来的增量数据。支持两种模式：

1. **合并模式（向后兼容）**：不传 `collection`，一次性返回三个集合。
2. **分页模式（推荐）**：传 `collection` 按集合分页拉取，避免初始同步把全部历史（含已删除会话的内嵌 `messages`）塞进单个响应。

#### 查询参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `since` | 非负整数 | 是 | 上次同步保存的 `latestVersion`，缺省按 `0` 处理 |
| `collection` | `agents` \| `conversations` \| `providers` | 否 | 指定后进入分页模式 |
| `cursor` | string | 否 | 分页游标（base64url 编码的 `{ version, id }`）；不能为空串 |
| `limit` | 正整数 | 否 | 每页大小，默认 100，上限 500 |

#### 合并模式响应（无 `collection`）

```jsonc
{
  "agents": [ /* AgentDoc[]，avatarUrl 已重写为 /api/avatars/agents/{id} */ ],
  "conversations": [ /* ConversationDoc[] */ ],
  "providers": [ /* ProviderDoc[] */ ],
  "latestVersion": 48
}
```

响应头：`Cache-Control: no-store`

#### 分页模式响应（带 `collection`）

```jsonc
{
  "collection": "conversations",
  "documents": [ /* 当前集合的文档，按 version 升序、_id 升序 */ ],
  "hasMore": true,
  "nextCursor": "eyJ2ZXJzaW9uIjo0NSwiaWQiOiJjb252..."}",  // hasMore=false 时为 null
  "latestVersion": 48
}
```

响应头：`Cache-Control: no-store`

#### 客户端协议建议

1. 对每个集合分别翻页：首次 `?since=N&collection=X`，之后 `?since=N&collection=X&cursor=...`，直到 `hasMore=false`。
2. 翻完一个集合后切换到下一个集合。
3. 三个集合全部拉完后，把响应中的 `latestVersion` 保存为新的 `since`。
4. 已删除实体的墓碑同样出现在 `documents` 中（`deleted: true`，仅含必要字段），客户端据此执行本地删除。
5. `agents` 集合中的 `avatarUrl` 会被重写为 `/api/avatars/agents/{id}`；`conversations` 与 `providers` 集合字段原样返回。

#### 错误

- `400 The since parameter must be a non-negative integer.`
- `400 collection must be one of: agents, conversations, providers.`
- `400 cursor must not be empty.`
- `400 limit must be a positive integer.`
- `401 Unauthorized.`
- `500 Unable to load synchronization data.`

---

## 头像 API

头像上传统一使用 `multipart/form-data`，字段名为 `file`（兼容旧字段 `avatar`）。允许的 MIME 与扩展名：

| MIME | 扩展名 |
| --- | --- |
| `image/jpeg` | `.jpg` |
| `image/png` | `.png` |
| `image/webp` | `.webp` |
| `image/gif` | `.gif` |

约束：文件大小 > 0 且 ≤ 5 MiB（`MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024`）。

头像替换流程（见 [`lib/avatars.ts`](./lib/avatars.ts)）：

1. 通过 `withAvatarLock()` 串行化对同一目标的并发修改（MongoDB 文档锁 + `renewAvatarLock` 续期）。
2. 快照当前头像（`snapshot*Avatar`），便于失败回滚。
3. 先把 DB 中的 `avatarUrl` 置空，再上传新 Blob；上传失败时尝试恢复旧文件。
4. 上传成功后写入新 `avatarUrl` 与 `avatarVersion`（= `Date.now()`）。
5. 删除操作先清空 DB 字段再删 Blob。

所有头像 GET 走认证代理：服务端经 `BlobStore` 接口（`lib/blob-store.ts`，Vercel Blob / 文件系统双后端）以条件 GET（`If-None-Match` → 304）流式返回内容。

### GET /api/avatars/user

读取当前用户头像。

- 鉴权：用户会话
- 请求头（可选）：`If-None-Match: <etag>`
- 响应 `200`：二进制流，`Content-Type` 为原始类型，附带 `ETag`、`Cache-Control: private, no-cache`、`X-Content-Type-Options: nosniff`
- 响应 `304`：客户端 ETag 仍有效
- 错误：`401`、`404 Avatar not found.`（未设置头像或 Blob 不存在）、`500 Unable to load the user avatar.`

### PUT /api/avatars/user

上传或替换当前用户头像。

- 鉴权：用户会话
- 请求体：`multipart/form-data`，字段 `file`（或 `avatar`）
- 响应 `200`：

```json
{
  "url": "http://localhost:3000/api/avatars/user",
  "version": 49,                 // 用户实体新版本号
  "avatarVersion": 1700000000000 // 头像版本，用于客户端缓存击穿
}
```

- 错误：`400 Upload a JPEG, PNG, WebP, or GIF avatar no larger than 5 MiB.`、`401`、`404 User not found.`、`500 Unable to update the user avatar.`

### DELETE /api/avatars/user

删除当前用户头像。

- 鉴权：用户会话
- 响应 `200`：

```json
{ "url": null, "version": 50, "avatarVersion": null }
```

- 错误：`401`、`404 User not found.`、`500 Unable to delete the user avatar.`

### GET /api/avatars/agents/{agentId}

读取指定 Agent 的头像。仅当 Agent 存在、未删除且 `avatarUrl` 非空时返回。

- 鉴权：用户会话
- 路径参数：`agentId`（满足 `entityIdSchema`）
- 请求头（可选）：`If-None-Match`
- 响应 `200` / `304`：同用户头像
- 错误：`400 Invalid agent ID.`、`401`、`404 Avatar not found.`、`500 Unable to load the agent avatar.`

### PUT /api/avatars/agents/{agentId}

上传或替换指定 Agent 的头像。要求 Agent 存在且未删除。

- 鉴权：用户会话
- 请求体：`multipart/form-data`
- 响应 `200`：

```json
{
  "url": "http://localhost:3000/api/avatars/agents/agent-uuid",
  "version": 51,
  "avatarVersion": 1700000000000
}
```

- 错误：`400 Invalid agent ID.`、`400 Upload a JPEG, PNG, WebP, or GIF avatar no larger than 5 MiB.`、`401`、`404 Agent not found.`、`500 Unable to update the agent avatar.`

### DELETE /api/avatars/agents/{agentId}

删除指定 Agent 的头像。

- 鉴权：用户会话
- 响应 `200`：`{ "url": null, "version": 52, "avatarVersion": null }`
- 错误：`400 Invalid agent ID.`、`401`、`404 Agent not found.`、`500 Unable to delete the agent avatar.`

> 删除 Agent（`DELETE /api/agents/{id}`）会一并清理其头像，无需单独调用本端点。

---

## Agent 市场 API

Agent 市场是面向所有已登录用户的公开 Agent 模板库。**所有市场路由都要求用户会话**，但服务器从不返回发布者身份。仅 entry 所有者可更新、上传/删除头像、下架。

市场 Agent 与用户本地的 Agent 是两套数据：

- 市场 entry 不含 provider 配置、API Key、模型绑定、follow-default 标志。
- 客户端通过本地 Agent 上的 `marketAgentId` / `marketAgentVersion` / `marketAgentRole` 字段记录与某条市场 entry 的关联。

### GET /api/market/agents

分页列出市场 Agent，按 `updatedAt` 降序、`_id` 升序。

- 鉴权：用户会话
- 查询参数：

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | string | `""` | 名称模糊匹配（正则，大小写不敏感），截断 200 字符 |
| `cursor` | string | 无 | base64url 编码的 `{ updatedAt, id }` |
| `limit` | 整数 | `30` | 实际取值会被夹到 `[1, 50]` |

- 响应 `200`：

```jsonc
{
  "agents": [
    {
      "id": "market-agent-uuid",
      "name": "翻译助手",
      "avatarUrl": "http://localhost:3000/api/market/agents/market-agent-uuid/avatar",
      "avatarVersion": 1700000000000,
      "systemPrompt": "...",
      "temperature": 0.3,
      "topP": 1,
      "maxTokens": 2048,
      "reasoningEffort": null,
      "createdAt": 1700000000000,
      "updatedAt": 1700000000000,
      "version": 3
    }
  ],
  "nextCursor": "eyJ1cGRhdGVkQXQiOjE3MDAw..."
}
```

- 错误：`401`、`500 Unable to list market agents.`

### POST /api/market/agents

发布一个市场 Agent。所有者自动绑定为当前用户。

- 鉴权：用户会话
- 请求体：`marketAgentSchema`（strict）

```jsonc
{
  "name": "翻译助手",
  "systemPrompt": "You translate text between Chinese and English.",
  "temperature": 0.3,
  "topP": 1,
  "maxTokens": 2048,           // 可选，可为 null
  "reasoningEffort": "low"     // 可选，可为 null
}
```

- 响应 `201`：`{ "agent": <MarketAgent 见上> }`
- 错误：`400 Invalid market agent payload.`、`401`、`500 Unable to publish the market agent.`

### GET /api/market/agents/{id}

获取单个市场 Agent。响应中额外返回 `isOwner` 标识，便于客户端决定是否显示编辑/下架按钮。

- 鉴权：用户会话
- 响应 `200`：

```json
{
  "agent": { /* MarketAgent 同上 */ },
  "isOwner": true
}
```

- 错误：`400 Invalid market agent ID.`、`401`、`404 Market Agent not found.`、`500 Unable to load the market agent.`

### PUT /api/market/agents/{id}

更新市场 Agent。仅所有者可调用。

- 鉴权：用户会话（所有者）
- 请求体：`marketAgentSchema`
- 响应 `200`：`{ "agent": <MarketAgent> }`
- 错误：`400`、`401`、`404 Market Agent not found.`（不存在或不属于当前用户）、`500 Unable to update the market agent.`

> 更新会 `$inc version` 并刷新 `updatedAt`，但不会重置 `avatarUrl`。

### DELETE /api/market/agents/{id}

下架市场 Agent（软删除）。仅所有者可调用。下架后该 entry 不再出现在列表与详情中。

- 鉴权：用户会话（所有者）
- 响应 `200`：`{ "success": true }`
- 错误：`400 Invalid market agent ID.`、`401`、`404 Market Agent not found.`、`500 Unable to remove the market agent.`

### GET /api/market/agents/{id}/avatar

读取市场 Agent 头像。要求 entry 存在且 `avatarUrl` 非空（不校验所有者，所有登录用户均可读）。

- 鉴权：用户会话
- 请求头（可选）：`If-None-Match`
- 响应 `200` / `304`：同其他头像端点
- 错误：`400 Invalid market agent ID.`、`401`、`404 Avatar not found.`、`500 Unable to load the market avatar.`

### PUT /api/market/agents/{id}/avatar

上传或替换市场 Agent 头像。仅所有者可调用。

- 鉴权：用户会话（所有者）
- 请求体：`multipart/form-data`
- 响应 `200`：

```json
{
  "url": "http://localhost:3000/api/market/agents/market-agent-uuid/avatar",
  "version": 4,
  "avatarVersion": 1700000000000
}
```

- 错误：`400 Invalid market agent ID.`、`400 Upload a JPEG, PNG, WebP, or GIF avatar no larger than 5 MiB.`、`401`、`404 Market Agent not found.`（不存在或不属于当前用户）、`500 Unable to update the market avatar.`

### DELETE /api/market/agents/{id}/avatar

删除市场 Agent 头像。仅所有者可调用。

- 鉴权：用户会话（所有者）
- 响应 `200`：`{ "url": null, "version": 5, "avatarVersion": null }`
- 错误：`400 Invalid market agent ID.`、`401`、`404 Market Agent not found.`、`500 Unable to delete the market avatar.`

---

## 数据模型

所有文档使用应用生成的字符串 ID 作为 MongoDB `_id`，时间戳为 Unix 毫秒。完整类型见 [`lib/types.ts`](./lib/types.ts)。

### UserDoc

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 用户 ID（UUID） |
| `email` | string | 唯一索引 |
| `passwordHash` | string | argon 风格哈希 |
| `role` | `"user"` \| `"admin"` | 管理权限；首个注册用户自动晋升 |
| `aiApiKey` | string | AI API Key（`sk-…`），有索引 |
| `quotaBalance` | number | 剩余额度（整数） |
| `quotaExpiresAt` | number \| null | 额度有效期；null 表示从未兑换 |
| `avatarUrl` | string \| null | 头像 Blob 私有 URL（由头像端点管理） |
| `avatarVersion` | number \| null | 头像版本 |
| `syncVersion` | number | 用户级单调水位线 |
| `createdAt` | number | |
| `updatedAt` | number | |
| `lastLoginAt` | number | 可选 |

### AgentDoc

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | Agent ID |
| `userId` | string | 所属用户 |
| `name` | string | |
| `avatarUrl` | string \| null | |
| `avatarVersion` | number \| null | |
| `systemPrompt` | string | |
| `defaultModelId` | string \| null | |
| `temperature` | number | |
| `topP` | number | |
| `maxTokens` | number \| null | |
| `reasoningEffort` | string \| null | |
| `isDefault` | boolean | 部分唯一索引保证每用户仅一个默认 Agent |
| `followDefaultSystemPrompt` | boolean | |
| `followDefaultModel` | boolean | |
| `followDefaultTemperature` | boolean | |
| `followDefaultTopP` | boolean | |
| `followDefaultMaxTokens` | boolean | |
| `followDefaultReasoningEffort` | boolean | |
| `marketAgentId` | string \| null | 关联的市场 Agent |
| `marketAgentVersion` | number \| null | |
| `marketAgentRole` | `"publisher"` \| `"importer"` \| null | |
| `createdAt` | number | |
| `updatedAt` | number | |
| `version` | number | 实体版本号，等于写入时的用户 `syncVersion` |
| `deleted` | boolean | 软删除标志 |

### ConversationDoc

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 会话 ID |
| `userId` | string | |
| `agentId` | string | |
| `title` | string | |
| `providerId` | string | 允许在 provider 尚未配置时为任意字符串 |
| `overrideModelId` | string \| null | |
| `overrideTemperature` | number \| null | |
| `overrideTopP` | number \| null | |
| `overrideMaxTokens` | number \| null | |
| `overrideReasoningEffort` | string \| null | |
| `reasoningFormat` | string \| null | |
| `messages` | MessageEmbed[] | 内嵌消息，上限 10 000 条 |
| `createdAt` | number | |
| `updatedAt` | number | |
| `version` | number | |
| `deleted` | boolean | |

#### MessageEmbed

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `role` | `"system"` \| `"user"` \| `"assistant"` \| `"tool"` | |
| `content` | string | |
| `partsJson` | string \| null | 多模态 ContentPart 数组的 JSON 字符串；纯文本为 null。图片 part 形如 `{"type":"image","dataUri":"data:image/...;base64,...","localPath":"..."}`，`dataUri` 内嵌完整图片字节；服务端原样存储/回传，客户端拉取后据此重建本地文件 |
| `timestamp` | number | |
| `status` | `"SENDING"` \| `"SENT"` \| `"ERROR"` | |
| `errorMessage` | string \| null | 可选 |

### ProviderDoc

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | |
| `userId` | string | |
| `name` | string | |
| `baseUrl` | string | |
| `apiKey` | string | 客户端需自行保护 |
| `models` | ModelEmbed[] | 内嵌模型 |
| `createdAt` | number | |
| `updatedAt` | number | |
| `version` | number | |
| `deleted` | boolean | |

#### ModelEmbed

| 字段 | 类型 |
| --- | --- |
| `id` | string |
| `modelId` | string |
| `displayName` | string |
| `isEnabled` | boolean |
| `createdAt` | number |

### MarketAgentDoc

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 服务端生成 |
| `ownerUserId` | string | 发布者，从不回传客户端 |
| `name` | string | |
| `avatarUrl` | string \| null | |
| `avatarVersion` | number \| null | |
| `systemPrompt` | string | |
| `temperature` | number | |
| `topP` | number | |
| `maxTokens` | number \| null | |
| `reasoningEffort` | string \| null | |
| `createdAt` | number | |
| `updatedAt` | number | |
| `version` | number | 市场 entry 版本号（与用户 `syncVersion` 无关） |
| `deleted` | boolean | |

### PlanDoc（套餐）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 套餐 ID |
| `name` | string | |
| `description` | string \| null | |
| `quotaTokens` | number | 兑换后一次性充入的额度 |
| `validityDays` | number | 有效期天数 |
| `price` | string \| null | 展示价格文案，不参与支付 |
| `enabled` | boolean | 停用后不出现在公开列表与开卡选项 |
| `sortOrder` | number | 展示排序 |
| `createdAt` / `updatedAt` | number | |

### CardKeyDoc（卡密）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | |
| `code` | string | `MS-XXXXX-XXXXX-XXXXX`，唯一索引 |
| `planId` | string | 开卡时的套餐 |
| `planName` / `quotaTokens` / `validityDays` | string / number / number | 创建时刻的套餐快照，套餐删除后仍可兑换 |
| `status` | `"unused"` \| `"redeemed"` \| `"disabled"` | |
| `note` | string \| null | 管理员备注 |
| `createdByUserId` | string | 开卡管理员 |
| `createdAt` | number | |
| `redeemedByUserId` / `redeemedAt` | string / number \| null | 兑换信息 |

### RedemptionDoc（兑换记录）、UpstreamDoc（上游，含按模型 modelMeta 元数据覆盖）、UsageLogDoc（用量）

- `RedemptionDoc`: `{ _id, userId, cardKeyId, cardCode, planId, planName, quotaTokens, validityDays, createdAt }`
- `UpstreamDoc`: `{ _id, name, baseUrl(含 /v1), apiKey, models: 可服务模型ID[], priority(小者先), enabled, createdAt, updatedAt }`
- `UsageLogDoc`: `{ _id, userId, modelId, upstreamId, promptTokens, completionTokens, totalTokens, cost, stream, createdAt }`

### system_bootstrap

`{ _id: "admin_bootstrap", grantedToUserId, createdAt }` —— 管理员晋升标记。注册事务以它的唯一键保证并发注册只产生一名管理员；启动迁移据此判断是否需要把最早用户提升为 admin。

### MongoDB 索引

服务首次连接时由 [`lib/mongo.ts`](./lib/mongo.ts) 初始化：

- `users`: 唯一 `{ email: 1 }`、`{ updatedAt: -1, _id: 1 }`、`{ aiApiKey: 1 }`
- `agents`: `{ userId: 1, version: 1 }`
- `conversations`: `{ userId: 1, version: 1 }`、`{ userId: 1, agentId: 1 }`
- `providers`: `{ userId: 1, version: 1 }`
- `market_agents`: `{ deleted: 1, updatedAt: -1, _id: 1 }`、`{ ownerUserId: 1, deleted: 1 }`
- `card_keys`: 唯一 `{ code: 1 }`、`{ status: 1, createdAt: -1, _id: 1 }`、`{ planId: 1, status: 1 }`
- `redemptions`: `{ userId: 1, createdAt: -1, _id: 1 }`
- `usage_logs`: `{ userId: 1, createdAt: -1, _id: 1 }`、`{ createdAt: -1, _id: 1 }`
- 额外的部分唯一索引保护「每用户一个活跃默认 Agent」不变式

### 头像 Blob 路径

两种 Blob 后端（Vercel / 文件系统，见 README「Avatar Storage」）共用稳定的逻辑路径：

- 用户头像：`avatars/users/{userId}.{ext}`
- Agent 头像：`avatars/agents/{agentId}.{ext}`
- 市场 Agent 头像：`avatars/market_agents/{marketAgentId}.{ext}`

---

## 错误码参考

| HTTP | 触发场景（汇总） |
| --- | --- |
| 400 | Zod 校验失败、ID 不合法、`since`/`cursor`/`limit` 参数不合法、头像文件超限或类型不支持、`/v1` 请求体缺 `model`/`messages` |
| 401 | 缺失/过期的会话；登录密码错误；改密时 `currentPassword` 错误；无效 AI API Key（OpenAI 格式错误体） |
| 402 | AI API 额度耗尽或套餐过期（OpenAI 格式错误体，`type: "insufficient_quota"`） |
| 403 | 非管理员访问 `/api/admin/*` |
| 404 | 实体不存在、头像未设置、市场 Agent 不存在或不属于当前用户、模型不可用 / 无可用上游 |
| 409 | 唯一约束冲突（重复邮箱、重复默认 Agent）、卡密已被使用、`ConflictError`、`AvatarLockError` |
| 500 | 其他未捕获错误；详情写入服务端日志，响应体仅返回通用 `fallbackMessage` |
| 502 | 上游探测/转发失败、全部上游不可用（OpenAI 格式错误体） |

通用错误响应体：

```json
{ "error": "描述信息" }
```
