import Link from "next/link";
import { redirect } from "next/navigation";
import { AdminLogoutButton } from "@/components/admin-logout-button";
import { requireAdminSession } from "@/lib/auth";
import { ADMIN_USER_PAGE_SIZE, getAdminDashboard } from "@/lib/storage";

function formatTime(timestamp: number | null | undefined) {
  return timestamp == null ? "None" : new Date(timestamp).toLocaleString();
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await requireAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  const { cursor } = await searchParams;
  const dashboard = await getAdminDashboard({ cursor });
  const { users, stats, nextCursor, hasMore } = dashboard;

  return (
    <main>
      <div className="shell grid">
        <section className="panel" style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
          <div>
            <div className="kicker">Admin Dashboard</div>
            <h1 style={{ marginBottom: 6 }}>Messenger account server</h1>
            <p className="muted">View MongoDB-backed account and incremental synchronization activity.</p>
          </div>
          <AdminLogoutButton />
        </section>

        <section className="stats">
          <div className="panel">
            <div className="kicker">Users</div>
            <div className="stat-value">{stats.users.count}</div>
          </div>
          <div className="panel">
            <div className="kicker">Agents</div>
            <div className="stat-value">{stats.agents.count}</div>
          </div>
          <div className="panel">
            <div className="kicker">Conversations</div>
            <div className="stat-value">{stats.conversations.count}</div>
          </div>
          <div className="panel">
            <div className="kicker">Providers</div>
            <div className="stat-value">{stats.providers.count}</div>
          </div>
        </section>

        <section className="panel grid">
          <div className="kicker">Accounts (page size {ADMIN_USER_PAGE_SIZE})</div>
          <div className="list">
            {users.length === 0 ? (
              <div className="list-item">
                <div>
                  <strong>No users yet</strong>
                  <p className="muted">Once Messenger clients register, they will appear here.</p>
                </div>
              </div>
            ) : (
              users.map((user) => (
                <div key={user.id} className="list-item">
                  <div>
                    <strong>{user.email}</strong>
                    <div className="muted code">{user.id}</div>
                  </div>
                  <div>
                    <div className="muted">Created</div>
                    <div>{formatTime(user.createdAt)}</div>
                  </div>
                  <div>
                    <div className="muted">Latest Update</div>
                    <div>{formatTime(user.updatedAt)}</div>
                  </div>
                  <div>
                    <div className="muted">Sync Version</div>
                    <div className="code">{user.syncVersion}</div>
                  </div>
                </div>
              ))
            )}
          </div>
          {hasMore && nextCursor ? (
            <div style={{ marginTop: 12 }}>
              <Link href={`/admin?cursor=${encodeURIComponent(nextCursor)}`} className="muted code">
                Older →
              </Link>
            </div>
          ) : null}
        </section>

        <section className="panel grid">
          <div className="kicker">Collection Activity</div>
          <div className="list">
            <div className="list-item">
              <strong>Users</strong>
              <span className="code">{stats.users.count} documents</span>
              <span className="muted">Latest update: {formatTime(stats.users.latestUpdatedAt)}</span>
            </div>
            <div className="list-item">
              <strong>Agents</strong>
              <span className="code">{stats.agents.count} documents</span>
              <span className="muted">Latest update: {formatTime(stats.agents.latestUpdatedAt)}</span>
            </div>
            <div className="list-item">
              <strong>Conversations</strong>
              <span className="code">{stats.conversations.count} documents</span>
              <span className="muted">Latest update: {formatTime(stats.conversations.latestUpdatedAt)}</span>
            </div>
            <div className="list-item">
              <strong>Providers</strong>
              <span className="code">{stats.providers.count} documents</span>
              <span className="muted">Latest update: {formatTime(stats.providers.latestUpdatedAt)}</span>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
