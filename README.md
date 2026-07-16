# Messenger Server

`server/` is the standalone Next.js account and incremental-sync service for Messenger. It is intended for Vercel deployment. MongoDB stores synchronized application entities, while the Vercel Blob-compatible SDK stores only user and agent avatar files.

## Features

- Email/password accounts with JWT cookie sessions
- MongoDB-backed versioned entity synchronization
- Per-user monotonic synchronization watermarks
- Soft-delete tombstones for multi-device deletion propagation
- Embedded messages per conversation and embedded models per provider
- Vercel Blob avatar lifecycle management
- Protected admin dashboard with MongoDB activity statistics

## Environment

Copy `.env.example` to `.env.local` for local development.

- `JWT_SECRET`: signs app and admin session cookies.
- `ADMIN_PASSWORD`: password for `/admin/login`.
- `APP_BASE_URL`: displayed by the server landing page.
- `MONGODB_URI`: MongoDB connection string. Use MongoDB Atlas or a replica set because versioned entity writes use transactions.
- `MONGODB_DB_NAME`: database name; defaults to `messenger`.
- `BLOB_READ_WRITE_TOKEN`: Blob store token used only for avatar files.
- `BLOB_STORE_ID`: Blob store identifier, `local` for the local emulator.
- `VERCEL_BLOB_API_URL`: Blob control API URL. Use `http://localhost:3100/api/blob` locally.
- `VERCEL_BLOB_STORAGE_URL`: Blob storage URL. Use `http://localhost:3100/blob` locally.
- `VERCEL_BLOB_RETRIES`: Set to `0` for local development to avoid retry delays.

## Data Model

All documents use application-generated string IDs as MongoDB `_id` values. Timestamps are Unix epoch milliseconds.

- `users`: `_id`, `email`, `passwordHash`, `avatarUrl`, `syncVersion`, `createdAt`, `updatedAt`, and `lastLoginAt`.
- `agents`: `_id`, `userId`, agent configuration, `avatarUrl`, `version`, and `deleted`.
- `conversations`: `_id`, `userId`, `agentId`, conversation overrides, one embedded `messages` array, `version`, and `deleted`.
- `providers`: `_id`, `userId`, provider settings, one embedded `models` array, `version`, and `deleted`.

Messages are stored inside their owning conversation. Models are stored inside their owning provider. A delete sets `deleted: true`; tombstones remain available to delta sync clients.

Every entity write uses `findOneAndUpdate` with `$inc: { syncVersion: 1 }` inside the same MongoDB transaction that stamps the changed entity's `version`. This prevents a sync response from advancing its watermark past an uncommitted entity write.

Registration inserts a user with `syncVersion: 0`, then creates the required default agent in the same transaction. That first entity write advances the account watermark to `1`, so an initial `GET /api/sync?since=0` includes the default agent.

## Indexes

The server initializes these indexes when it first connects:

- `users`: unique `{ email: 1 }`
- `agents`: `{ userId: 1, version: 1 }`
- `conversations`: `{ userId: 1, version: 1 }`
- `conversations`: `{ userId: 1, agentId: 1 }`
- `providers`: `{ userId: 1, version: 1 }`

An additional partial unique index protects the one-active-default-agent invariant for each user.

## Avatar Storage

The Vercel Blob-compatible SDK is not used for backup payloads. It stores private avatar files at stable pathnames:

- User avatars: `avatars/users/{userId}.{ext}`
- Agent avatars: `avatars/agents/{agentId}.{ext}`

Avatar replacement snapshots the previous file with `get(..., { access: "private" })`, deletes prefix-matched blobs, and restores the prior file if the replacement upload fails. Per-avatar locks and ETag-conditional Blob deletes prevent a stale request from overwriting or deleting a newer avatar. Agent deletion removes its avatar Blob and clears `avatarUrl`. Avatar uploads accept JPEG, PNG, WebP, and GIF files up to 5 MiB.

Private Blob URLs are never returned to clients as directly readable image URLs. Authenticated avatar routes stream the Blob through `get(..., { access: "private" })`, and mobile clients load those routes with the Messenger session cookie.

## API

All sync, entity, and avatar routes require a valid `messenger_session` cookie. A request without a valid session returns `401 Unauthorized`.

### Authentication

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PUT /api/auth/password`
- `DELETE /api/auth/account`

`PUT /api/auth/password` requires `currentPassword` and `newPassword`. `DELETE /api/auth/account` requires a JSON body containing `currentPassword` and permanently removes the authenticated user's account, synchronized entities, and avatars.

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

## Local Development

Use a MongoDB replica set locally, for example a single-node `mongod --replSet rs0`, then initialize it once with `rs.initiate()` in `mongosh`.

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000` for the landing page and `http://localhost:3000/admin/login` for the admin portal. When using [vercel-blob-emu](https://github.com/ECSDevs/vercel-blob-emu), start its emulator on port `3100` and point `VERCEL_BLOB_API_URL` and `VERCEL_BLOB_STORAGE_URL` at that service.

Run validation with:

```bash
pnpm typecheck
pnpm lint
```

## Breaking Change

The former Redis/Vercel Blob whole-backup system and `/api/backups/*` endpoints were removed. Existing backup JSON payloads are not migrated automatically; a one-time migration is intentionally out of scope.
