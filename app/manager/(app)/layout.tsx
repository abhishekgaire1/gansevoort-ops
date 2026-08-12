import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { signOutManager } from "@/app/actions/managerAuth";

/**
 * The auth guard for every real manager route (this route group -- app/manager/(app)/
 * -- doesn't affect URLs: app/manager/(app)/receiving resolves to /manager/receiving).
 * requireManagerOrAdmin() is reused completely unchanged from Milestone 2A.0;
 * this is the one place its result is turned into a redirect.
 */
export default async function ManagerAppLayout({ children }: { children: ReactNode }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect("/manager/login");
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
        <Link
          href="/manager/receiving"
          className="text-sm font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-200"
        >
          Gansevoort Manager
        </Link>
        <form action={signOutManager}>
          <button type="submit" className="text-sm text-zinc-400 underline-offset-4 hover:text-zinc-200 hover:underline">
            Sign Out
          </button>
        </form>
      </header>
      <main className="px-6 py-8">{children}</main>
    </div>
  );
}
