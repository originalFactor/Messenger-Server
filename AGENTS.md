# Agent Instructions

## Commands

- Use Node.js 20+ and pnpm. Install dependencies with `pnpm install`.
- Run the development server with `pnpm dev`; production checks are `pnpm build` and `pnpm start`.
- Before handing off changes, run `pnpm lint` and `pnpm typecheck`; there is no configured test runner.
- Local MongoDB must be a replica set (for example `mongod --replSet rs0`, then `rs.initiate()` in `mongosh`) because entity writes use transactions.

## Structure

- This is a single Next.js App Router application, not a workspace despite the `pnpm-workspace.yaml` file. Pages are under `app/`; API route handlers are under `app/api/`.
- `lib/storage.ts` is the persistence boundary for users, agents, conversations, providers, incremental sync watermarks, and tombstones. `lib/mongo.ts` also initializes indexes on first database access.
- Versioned entity mutations must remain in the MongoDB transaction that increments the user `syncVersion` and stamps the entity `version`; sync reads first capture the waterline and bound collection queries to it.
- Messages are embedded in conversations and models are embedded in providers. Deletes are soft deletes so tombstones remain available to `GET /api/sync?since=N`.
- Avatar routes use Vercel Blob only for avatar files. `lib/avatars.ts` handles prefix snapshots/replacement/rollback, while `lib/avatar-locks.ts` serializes concurrent changes through MongoDB; preserve both protections when changing avatar behavior.
- User and admin routes use different JWT cookies and guards from `lib/auth.ts`: `messenger_session` for application APIs and `messenger_admin_session` for `/admin`.
- Account routes include authenticated password changes at `PUT /api/auth/password` and permanent account deletion at `DELETE /api/auth/account`; deletion removes the user's MongoDB entities and avatar blobs before clearing the session cookie.

## Environment

- Copy `.env.example` to `.env.local`. `JWT_SECRET`, `ADMIN_PASSWORD`, and `MONGODB_URI` are required at runtime; `MONGODB_DB_NAME` defaults to `messenger`, and `APP_BASE_URL` defaults to `http://localhost:3000`.
- `BLOB_READ_WRITE_TOKEN` is needed for avatar operations and is not used for database or backup storage.
- Keep secrets out of source control; `.env.*` is ignored except `.env.example`.

## Conventions

- Use the `@/*` path alias for imports from the repository root.
- API handlers validate request bodies and route IDs with the Zod schemas in `lib/validation.ts`, authenticate before accessing user data, and map storage failures through `lib/route-errors.ts`.
- Keep API routes that touch MongoDB or Blob on the Node runtime (`export const runtime = "nodejs"`).
