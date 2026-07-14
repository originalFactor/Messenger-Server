# Messenger Server

`server/` is a standalone Next.js account and cloud-backup service for Messenger. It is designed for Vercel deployment and keeps the Android app's local-first model intact by only storing encrypted-or-plain app backup payloads that clients upload explicitly.

## Features

- App account registration and login
- JWT cookie session for app clients
- Vercel KV metadata storage
- Vercel Blob backup payload storage
- Admin login and dashboard for user and backup visibility
- App Router + serverless route handlers

## Data Model

The mobile app can upload a single backup document shaped around Messenger's core entities:

```json
{
  "schemaVersion": 1,
  "exportedAt": 1750000000000,
  "device": {
    "platform": "android",
    "appVersion": "v20260714"
  },
  "providers": [],
  "agents": [],
  "conversations": [],
  "messages": []
}
```

The server treats that payload as opaque application data except for basic validation and metadata extraction.

## Environment

Copy `.env.example` to `.env.local` for local development.

- `JWT_SECRET`: used to sign user and admin sessions
- `ADMIN_PASSWORD`: password for `/admin/login`
- `APP_BASE_URL`: base URL used by admin UI and debugging
- `KV_REST_API_URL` / `KV_REST_API_TOKEN`: Vercel KV credentials
- `BLOB_READ_WRITE_TOKEN`: Vercel Blob token

## Local Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000` for the landing page and `http://localhost:3000/admin/login` for the admin portal.

## API Summary

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PUT /api/backups/latest`
- `GET /api/backups/latest`
- `GET /api/backups/manifest`

## Storage Layout

- KV user record: `messenger:user:{userId}`
- KV email index: `messenger:user:by-email:{normalizedEmail}`
- KV user index: `messenger:users:index`
- KV backup manifest: `messenger:backup:{userId}:manifest`
- Blob payload path: `backups/{userId}/{version}.json`
