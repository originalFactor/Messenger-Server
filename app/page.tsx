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

import Link from "next/link";
import { env } from "@/lib/env";

export default function HomePage() {
  return (
    <main>
      <div className="shell grid">
        <section className="hero">
          <div className="panel">
            <div className="kicker">Messenger Cloud</div>
            <h1 className="title">Account and incremental sync for Messenger.</h1>
            <p className="muted">
              This server stores Messenger accounts and synchronized entities in MongoDB. Vercel Blob stores only
              user and agent avatars, while clients exchange versioned deltas for multi-device synchronization.
            </p>
          </div>
          <div className="panel grid">
            <div>
              <div className="kicker">Endpoints</div>
              <p className="code">POST /api/auth/register</p>
              <p className="code">POST /api/auth/login</p>
              <p className="code">GET /api/sync?since=N</p>
              <p className="code">PUT /api/conversations/:id</p>
              <p className="code">PUT /api/avatars/agents/:id</p>
            </div>
            <div>
              <div className="kicker">Admin</div>
              <p className="muted">Use the protected backend to inspect registered users and MongoDB synchronization activity.</p>
              <Link className="button-secondary" href="/admin/login">
                Open Admin Login
              </Link>
            </div>
            <div>
              <div className="kicker">Base URL</div>
              <p className="code">{env.appBaseUrl()}</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
