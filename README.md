# Messenger Server

`server/` is the standalone Next.js SaaS service for Messenger: official website, web console, account & incremental sync, card-key plan billing, and the built-in AI API (upstream model relay). It runs on Vercel and on any self-hosted Node runtime. MongoDB stores synchronized application entities, billing data, and market snapshots, while avatar files live in a pluggable blob storage layer (Vercel Blob backend or a self-hosted filesystem backend).

## Features

- Official website homepage with public plan/pricing display and web login/registration
- Shared web console (`/console`) for users and administrators; the first registered user is automatically promoted to admin
- Email/password accounts with JWT cookie sessions
- MongoDB-backed versioned entity synchronization with per-user monotonic watermarks and soft-delete tombstones
- Card-key (卡密) plan system: admin-defined plans, batch card issuance, user redemption with quota and validity extension
- Per-model rate billing consumed by the built-in AI API
- OpenAI-compatible AI API (`/v1/models`, `/v1/chat/completions`) relaying to admin-managed upstream model services with priority failover
- Pluggable blob storage for avatars: Vercel Blob backend (existing deployments keep working) or self-hosted filesystem backend replacing the former local emulator
- Authenticated public Agent Market with publish, update, import, and unpublish workflows
- Vercel Blob-compatible avatar lifecycle management (snapshot/replacement/rollback semantics) regardless of backend

## Environment

Copy `.env.example` to `.env.local` for local development.

- `JWT_SECRET`: signs the user session cookie (user and admin roles share the same session format).
- `APP_BASE_URL`: absolute base URL used to rewrite avatar URLs and shown on the website footer.
- `MONGODB_URI`: MongoDB connection string. Use MongoDB Atlas or a replica set because versioned entity writes and redemptions use transactions.
- `MONGODB_DB_NAME`: database name; defaults to `messenger`.

### Blob storage (avatars)

- `BLOB_BACKEND`: `auto` (default) | `fs` | `vercel`. With `auto`, a configured `BLOB_READ_WRITE_TOKEN` selects the Vercel Blob backend (unchanged behavior for Vercel deployments); otherwise the filesystem backend is used.
- `BLOB_STORAGE_DIR`: filesystem backend root directory; defaults to `./.blobs`. Requires a persistent disk (self-hosted deployments), and is git-ignored.

The following variables only apply to the Vercel Blob backend (`BLOB_BACKEND=vercel` or a Vercel deployment); local development and self-hosting need none of them: `BLOB_READ_WRITE_TOKEN`, `BLOB_STORE_ID`, `VERCEL_BLOB_API_URL`, `VERCEL_BLOB_STORAGE_URL`, `VERCEL_BLOB_RETRIES`.

The former `ADMIN_PASSWORD` variable is removed: administration is a user role granted to the first registered account.

## Data Model

All documents use application-generated string IDs as MongoDB `_id` values. Timestamps are Unix epoch milliseconds.

- `users`: `_id`, `email`, `passwordHash`, `role` (`user` | `admin`), `aiApiKey`, `quotaBalance`, `quotaExpiresAt`, `avatarUrl`, `syncVersion`, `createdAt`, `updatedAt`, and `lastLoginAt`.
- `agents`: `_id`, `userId`, agent configuration, `avatarUrl`, `version`, and `deleted`.
- `conversations`: `_id`, `userId`, `agentId`, conversation overrides, one embedded `messages` array, `version`, and `deleted`.
- `providers`: `_id`, `userId`, provider settings, one embedded `models` array, `version`, and `deleted`.
- `market_agents`: server-generated `_id`, `ownerUserId`, portable Agent snapshot, avatar metadata, market `version`, and `deleted`. Entries never include provider settings, API keys, model bindings, or follow-default flags.
- `plans`: admin-defined plans (`name`, `description`, `quotaTokens`, `validityDays`, display `price`, `enabled`, `sortOrder`).
- `card_keys`: voucher codes with a creation-time plan snapshot (`planName`, `quotaTokens`, `validityDays`), `status` (`unused` | `redeemed` | `disabled`), `note`, and redemption metadata.
- `redemptions`: one document per successful redemption (user, card, plan snapshot, timestamp).
- `ai_models`: the model catalog consumed by the AI API (`_id` = model ID, `rate` multiplier, `enabled`).
- `upstreams`: admin-managed upstream OpenAI-compatible services (`baseUrl` including `/v1`, `apiKey`, served `models`, `priority`, `enabled`).
- `usage_logs`: one document per AI API completion (tokens and quota `cost`, upstream, stream flag).
- `system_bootstrap`: the `admin_bootstrap` marker that makes the first-admin grant race-safe.

Messages are stored inside their owning conversation. Models are stored inside their owning provider. A delete sets `deleted: true`; tombstones remain available to delta sync clients.

Every entity write uses `findOneAndUpdate` with `$inc: { syncVersion: 1 }` inside the same MongoDB transaction that stamps the changed entity's `version`. This prevents a sync response from advancing its watermark past an uncommitted entity write.

Registration inserts a user with `syncVersion: 0`, then creates the required default agent in the same transaction. When no admin exists, the registering user is promoted to `admin` in the same transaction (guarded by the unique `system_bootstrap` marker). Card redemption, quota consumption, and account deletion are likewise transactional.

## Indexes

The server initializes these indexes when it first connects:

- `users`: unique `{ email: 1 }`, `{ updatedAt: -1, _id: 1 }`, `{ aiApiKey: 1 }`
- `agents`: `{ userId: 1, version: 1 }`
- `conversations`: `{ userId: 1, version: 1 }`
- `conversations`: `{ userId: 1, agentId: 1 }`
- `providers`: `{ userId: 1, version: 1 }`
- `market_agents`: `{ deleted: 1, updatedAt: -1, _id: 1 }` and `{ ownerUserId: 1, deleted: 1 }`
- `card_keys`: unique `{ code: 1 }`, `{ status: 1, createdAt: -1, _id: 1 }`, `{ planId: 1, status: 1 }`
- `redemptions`: `{ userId: 1, createdAt: -1, _id: 1 }`
- `usage_logs`: `{ userId: 1, createdAt: -1, _id: 1 }` and `{ createdAt: -1, _id: 1 }`

An additional partial unique index protects the one-active-default-agent invariant for each user.

## Avatar Storage

Avatar files live behind `lib/blob-store.ts`, a small pluggable storage interface with two backends:

- **`fs` backend** (`lib/blob-fs.ts`): the real, self-hosted implementation that replaces the former `vercel-blob-emu` emulator. Content is stored under `BLOB_STORAGE_DIR` (default `./.blobs`) with a `.meta.json` sidecar holding the sha256 ETag and content type. Missing sidecars are tolerated (ETag recomputed from content, content type guessed from the extension), so migrating from another storage simply means copying the `avatars/` file tree into `BLOB_STORAGE_DIR`. Requires a persistent disk.
- **`vercel` backend** (`lib/blob-vercel.ts`): a pass-through adapter over `vercel-blob-nonvercel` with the exact call semantics the server has always used, keeping existing Vercel deployments fully compatible with no data migration.

Selection: `BLOB_BACKEND=auto` (default) picks Vercel when `BLOB_READ_WRITE_TOKEN` is set, otherwise `fs`; `BLOB_BACKEND=fs|vercel` forces either backend.

Stable logical pathnames are used by both backends:

- User avatars: `avatars/users/{userId}.{ext}`
- Agent avatars: `avatars/agents/{agentId}.{ext}`
- Market Agent avatars: `avatars/market_agents/{agentId}.{ext}`

Avatar replacement snapshots the previous file, deletes prefix-matched blobs, and restores the prior file if the replacement upload fails. Per-avatar locks and ETag-conditional deletes prevent a stale request from overwriting or deleting a newer avatar (`lib/avatar-locks.ts`). Agent deletion removes its avatar and clears `avatarUrl`. Avatar uploads accept JPEG, PNG, WebP, and GIF files up to 5 MiB.

Raw blob URLs are never returned to clients as directly readable image URLs. Authenticated avatar routes stream the content through conditional GETs (ETag / `If-None-Match`), and mobile clients load those routes with the Messenger session cookie.

## API

See [`API.md`](./API.md) for the complete endpoint reference. Summary:

- Session-cookie routes (web console, entity sync, avatars, market) require a valid `messenger_session` cookie; admin-only routes additionally verify the database `role` and return `403 Forbidden` for non-admins.
- The AI API (`/v1/models`, `/v1/chat/completions`) authenticates with the per-user API key (`Authorization: Bearer sk-…`) shown in the web console.

### Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PUT /api/auth/password`
- `DELETE /api/auth/account`

`PUT /api/auth/password` requires `currentPassword` and `newPassword`. `DELETE /api/auth/account` requires a JSON body containing `currentPassword` and permanently removes the authenticated user's account, synchronized entities, billing history, usage logs, and avatars.

### Console (users)

- `GET /api/console/overview` — quota summary and recent usage
- `POST /api/console/redeem` — redeem a card key (atomic claim + quota grant + redemption record)
- `GET /api/console/redemptions` — redemption history
- `POST /api/console/api-key` — regenerate the AI API key (old key invalidates immediately)

### Admin

All `/api/admin/*` routes require the session user to have `role: "admin"` in the database:

- `GET /api/admin/overview` — site-wide statistics
- `GET|POST /api/admin/plans`, `PUT|DELETE /api/admin/plans/{id}` — plan CRUD
- `GET|POST /api/admin/cards`, `PATCH|DELETE /api/admin/cards/{id}` — card listing, batch issuance (1–500 per call), disabling, and deletion
- `GET|POST /api/admin/models`, `PUT|DELETE /api/admin/models/{id}` — model catalog with per-model billing rates
- `GET|POST /api/admin/upstreams`, `PUT|DELETE /api/admin/upstreams/{id}`, `POST /api/admin/upstreams/{id}/probe` — upstream CRUD and model-list probing for one-click catalog import

### AI API (OpenAI-compatible)

- `GET /v1/models` — enabled catalog models served by at least one enabled upstream
- `POST /v1/chat/completions` — streaming and non-streaming relay; injects `stream_options.include_usage`, fails over across upstreams by priority, and deducts `ceil(totalTokens × rate)` from the user's quota after completion (402 when the quota is exhausted or expired)

### Entity Synchronization

- `PUT /api/agents/{id}`
- `DELETE /api/agents/{id}`
- `PUT /api/conversations/{id}`
- `DELETE /api/conversations/{id}`
- `PUT /api/providers/{id}`
- `DELETE /api/providers/{id}`
- `GET /api/sync?since=N`

Entity PUT requests accept the complete entity body without server-managed `version` or `deleted` fields. Conversation PUTs include the complete embedded message list; provider PUTs include the complete embedded model list. Successful writes return `{ id, version }`.

`GET /api/sync?since=N` returns:

```json
{
  "agents": [],
  "conversations": [],
  "providers": [],
  "latestVersion": 0
}
```

Each array contains active documents and tombstones with `version > N`. Clients apply the complete delta and then advance their local cursor to `latestVersion`.

### Avatars

- `PUT /api/avatars/user`
- `GET /api/avatars/user`
- `DELETE /api/avatars/user`
- `PUT /api/avatars/agents/{agentId}`
- `GET /api/avatars/agents/{agentId}`
- `DELETE /api/avatars/agents/{agentId}`

Avatar PUT requests use `multipart/form-data`, with a `file` field (the legacy `avatar` field is also accepted). Avatar responses include `{ url, version }`; delete responses set `url` to `null`.

### Agent Market

All market routes require a valid Messenger session. Listing is available to every signed-in user; the server never returns the publisher identity. Only the entry owner may update, upload/remove an avatar, or unpublish an entry.

- `GET /api/market/agents?query=&cursor=&limit=`
- `POST /api/market/agents`
- `GET /api/market/agents/{id}`
- `PUT /api/market/agents/{id}`
- `DELETE /api/market/agents/{id}`
- `GET`/`PUT`/`DELETE /api/market/agents/{id}/avatar`

Create and update payloads contain `name`, `systemPrompt`, `temperature`, `topP`, and optional `maxTokens`. Listing is sorted by most recently updated entry and uses the last returned ID as its cursor.

## Deployment

The service is a standard Next.js App Router application and runs on Vercel as well as on any self-hosted Node 20+ host:

```bash
pnpm install
pnpm build
pnpm start   # serves on $PORT (default 3000); put a reverse proxy in front for TLS
```

Self-hosted deployments should use the `fs` blob backend (default when no Vercel token is configured) and point `BLOB_STORAGE_DIR` at a persistent disk. The AI streaming proxy has a `maxDuration` export that Vercel clamps per plan; self-hosted runtimes have no function timeout.

## Local Development

Use a MongoDB replica set locally, for example a single-node `mongod --replSet rs0`, then initialize it once with `rs.initiate()` in `mongosh`.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` for the official website. Use `/register` to create the first account (it becomes the admin), then sign in at `/login` and manage the platform under `/console`. Local avatar files are written to `BLOB_STORAGE_DIR` (default `./.blobs`); no emulator or Vercel account is needed.

Run validation with:

```bash
pnpm typecheck
pnpm lint
```

## Breaking Changes

- The former Redis/Vercel Blob whole-backup system and `/api/backups/*` endpoints were removed. Existing backup JSON payloads are not migrated automatically; a one-time migration is intentionally out of scope.
- The `vercel-blob-emu` emulator submodule was removed. Local development uses the filesystem blob backend; existing deployments that move off Vercel can copy their stored `avatars/` file tree into `BLOB_STORAGE_DIR` (ETags are recomputed from content when sidecars are absent). Vercel deployments are unaffected.
