import { redirect } from "next/navigation";
import { AdminLoginForm } from "@/components/admin-login-form";
import { requireAdminSession } from "@/lib/auth";

export default async function AdminLoginPage() {
  const session = await requireAdminSession();
  if (session) {
    redirect("/admin");
  }

  return (
    <main>
      <div className="shell">
        <section className="panel" style={{ maxWidth: 460, margin: "0 auto" }}>
          <div className="kicker">Admin Backend</div>
          <h1>Sign in</h1>
          <p className="muted">Authenticate with the server admin password to access the Messenger backup dashboard.</p>
          <AdminLoginForm />
        </section>
      </div>
    </main>
  );
}
