import { redirect } from "next/navigation";
import { AdminLogoutButton } from "@/components/admin-logout-button";
import { requireAdminSession } from "@/lib/auth";
import { getBackupManifest, getUsersIndex } from "@/lib/storage";

export default async function AdminDashboardPage() {
  const session = await requireAdminSession();
  if (!session) {
    redirect("/admin/login");
  }

  const users = await getUsersIndex();
  const manifests = await Promise.all(users.map((user) => getBackupManifest(user.id)));
  const totalBackups = manifests.filter(Boolean).length;
  const totalMessages = manifests.reduce((sum, manifest) => sum + (manifest?.recordCounts.messages ?? 0), 0);

  return (
    <main>
      <div className="shell grid">
        <section className="panel" style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "center" }}>
          <div>
            <div className="kicker">Admin Dashboard</div>
            <h1 style={{ marginBottom: 6 }}>Messenger account server</h1>
            <p className="muted">View registered users and the metadata for the latest backup each account uploaded.</p>
          </div>
          <AdminLogoutButton />
        </section>

        <section className="stats">
          <div className="panel">
            <div className="kicker">Users</div>
            <div className="stat-value">{users.length}</div>
          </div>
          <div className="panel">
            <div className="kicker">Backups</div>
            <div className="stat-value">{totalBackups}</div>
          </div>
          <div className="panel">
            <div className="kicker">Messages Stored</div>
            <div className="stat-value">{totalMessages}</div>
          </div>
        </section>

        <section className="panel grid">
          <div className="kicker">Accounts</div>
          <div className="list">
            {users.length === 0 ? (
              <div className="list-item">
                <div>
                  <strong>No users yet</strong>
                  <p className="muted">Once Messenger clients register, they will appear here.</p>
                </div>
              </div>
            ) : (
              users.map((user, index) => {
                const manifest = manifests[index];
                return (
                  <div key={user.id} className="list-item">
                    <div>
                      <strong>{user.email}</strong>
                      <div className="muted code">{user.id}</div>
                    </div>
                    <div>
                      <div className="muted">Created</div>
                      <div>{new Date(user.createdAt).toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="muted">Latest Backup</div>
                      <div>{manifest ? new Date(manifest.uploadedAt).toLocaleString() : "None"}</div>
                    </div>
                    <div>
                      <div className="muted">Counts</div>
                      <div className="code">
                        {manifest
                          ? `P${manifest.recordCounts.providers} A${manifest.recordCounts.agents} C${manifest.recordCounts.conversations} M${manifest.recordCounts.messages}`
                          : "-"}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
