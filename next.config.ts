/*
 * Copyright 2026 ECSDevs
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

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        // Next.js does not resolve `public/app/index.html` for the directory
        // path `/app` (and `trailingSlash: false` redirects `/app/` to `/app`),
        // so the web client's URL needs an explicit rewrite. Without it the
        // canonical URL 404s while the assets still resolve, which is the
        // confusing half-working state.
        source: "/app",
        destination: "/app/index.html",
      },
    ];
  },
  async headers() {
    return [
      {
        // The Compose Multiplatform web client (Kotlin/Wasm) keeps renderer
        // state in shared memory, so its pages must be cross-origin isolated.
        // Scoped to /app/* deliberately: COEP breaks third-party embeds, so
        // the rest of the site must not carry these headers. The client is
        // served from public/app/ (see the webApp Gradle copy task), which
        // makes it same-origin with the API and keeps the session cookie
        // working with no CORS configuration.
        source: "/app/:path*",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
