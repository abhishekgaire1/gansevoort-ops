import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";

/**
 * Admin Foundation milestone -- /manager/admin has no content of its own
 * (Part 4: "No need to build a giant Admin dashboard... do not create
 * fake statistics/KPIs there"), it just resolves to Users. A non-admin
 * (or unauthenticated) request is rejected server-side here too, not
 * just by the sidebar being hidden (Part 5).
 */
export default async function AdminLandingPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }
  redirect("/manager/admin/users");
}
