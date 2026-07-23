# Messenger Server API

Messenger `server/` 是一个独立的 Next.js (App Router) 服务，提供账号、增量同步、头像和 Agent 市场能力，部署目标是 Vercel。所有业务数据存于 MongoDB（需为副本集），头像文件存于 Vercel Blob 兼容存储。

- **运行时**: Node.js ≥ 20，Next.js 15.4
- **路由运行时**: 所有触碰 MongoDB 或 Blob 的路由均声明 `export const runtime = "nodejs"`
- **包管理**: pnpm
- **基类**: TypeScript + Zod 校验

本文档对应 `app/api/**` 下全部 19 个路由处理器。如需了解部署、环境变量与本地开发，参见 [`README.md`](./README.md) 与 [`AGENTS.md`](./AGENTS.md)。

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
- [管理后台 API](#管理后台-api)
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

### 认证与 Cookie

服务端使用两套独立的 JWT 会话，均以 HS256 签名、HttpOnly + SameSite=Lax Cookie 下发：

| 会话 | Cookie 名 | 用途 | 有效期 | 签发者 |
| --- | --- | --- | --- | --- |
| 用户会话 | `messenger_session` | 访问所有 `/api/auth/*`、`/api/agents`、`/api/conversations`、`/api/providers`、`/api/sync`、`/api/avatars/*`、`/api/market/*` | 30 天 | `POST /api/auth/register`、`POST /api/auth/login` |
| 管理员会话 | `messenger_admin_session` | 访问 `/admin` 仪表盘（页面，非 API） | 12 小时 | `POST /api/admin/login` |

JWT Claims 结构：

```ts
interface SessionClaims {
  sub: string;       // 用户 ID 或 "admin"
  email?: string;    // 仅用户会话
  role: "user" | "admin";
}
```

鉴权行为：

- 除 `POST /api/auth/register`、`POST /api/auth/login`、`POST /api/admin/login`、`POST /api/admin/logout`、`POST /api/auth/logout` 外，所有路由都要求有效会话。
- 缺失/过期/角色不符的会话统一返回 `401 Unauthorized.`。
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
| POST | `/api/auth/register` | 无 | 注册账号并签发会话 |
| POST | `/api/auth/login` | 无 | 登录并签发会话 |
| POST | `/api/auth/logout` | 无 | 注销当前用户会话 |
| GET | `/api/auth/me` | 用户 | 获取当前用户信息 |
| PUT | `/api/auth/password` | 用户 | 修改密码 |
| DELETE | `/api/auth/account` | 用户 | 永久注销账户 |
| POST | `/api/admin/login` | 无 | 管理员登录 |
| POST | `/api/admin/logout` | 无 | 管理员注销 |
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

> 管理员仪表盘 `/admin` 与 `/admin/login` 为服务端渲染页面，不在 API 之列。

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
    "avatarUrl": "http://localhost:3000/api/avatars/user",
    "avatarVersion": 1700000000000,
    "syncVersion": 42,
    "createdAt": 1700000000000,
    "updatedAt": 1700000000000,
    "lastLoginAt": 1700000000000
  }
}
```

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

永久注销账户。在同一存储事务内删除该用户的所有 `agents`、`conversations`、`providers`、`market_agents` 文档，再异步清理三类头像 Blob，最后清除会话 Cookie。

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

## 管理后台 API

管理员后台仅通过服务端渲染页面 `/admin` 暴露。`/api/admin/*` 只提供登录/注销两个端点；仪表盘数据由 `getAdminDashboard()` 在页面内直接读取，不对外暴露 API。

### POST /api/admin/login

用配置的 `ADMIN_PASSWORD` 登录，签发管理员会话。

- 鉴权：无
- 请求体：

```json
{ "password": "管理员密码" }
```

- 响应 `200`：`{ "success": true }`
- 错误：`400 Password is required.`、`401 Invalid admin password.`

### POST /api/admin/logout

清除管理员会话 Cookie。幂等。

- 鉴权：无
- 响应 `200`：`{ "success": true }`

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

所有头像 GET 走认证代理：服务端用 `get(..., { access: "private" })` 拉取私有 Blob 并流式返回，支持 `If-None-Match` 条件请求。

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

### MongoDB 索引

服务首次连接时由 [`lib/mongo.ts`](./lib/mongo.ts) 初始化：

- `users`: 唯一 `{ email: 1 }`
- `agents`: `{ userId: 1, version: 1 }`
- `conversations`: `{ userId: 1, version: 1 }`、`{ userId: 1, agentId: 1 }`
- `providers`: `{ userId: 1, version: 1 }`
- `market_agents`: `{ deleted: 1, updatedAt: -1, _id: 1 }`、`{ ownerUserId: 1, deleted: 1 }`
- 额外的部分唯一索引保护「每用户一个活跃默认 Agent」不变式

### 头像 Blob 路径

- 用户头像：`avatars/users/{userId}.{ext}`
- Agent 头像：`avatars/agents/{agentId}.{ext}`
- 市场 Agent 头像：`avatars/market_agents/{marketAgentId}.{ext}`

---

## 错误码参考

| HTTP | 触发场景（汇总） |
| --- | --- |
| 400 | Zod 校验失败、ID 不合法、`since`/`cursor`/`limit` 参数不合法、头像文件超限或类型不支持 |
| 401 | 缺失/过期/角色不符的会话；登录密码错误；改密时 `currentPassword` 错误 |
| 404 | 实体不存在、头像未设置、市场 Agent 不存在或不属于当前用户 |
| 409 | 唯一约束冲突（重复邮箱、重复默认 Agent）、`ConflictError`、`AvatarLockError`（头像锁竞争） |
| 500 | 其他未捕获错误；详情写入服务端日志，响应体仅返回通用 `fallbackMessage` |

通用错误响应体：

```json
{ "error": "描述信息" }
```
