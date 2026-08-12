import { LoginForm } from "./_components/LoginForm";

/**
 * Outside the app/manager/(app)/ auth-guarded route group by design -- this
 * page must never itself redirect based on requireManagerOrAdmin(), or a
 * signed-out visitor would loop between /manager/login and its own guard.
 *
 * The Supabase URL/publishable key are read here (server-side) and passed
 * to the client LoginForm as props rather than exposed via NEXT_PUBLIC_
 * env vars -- matching .env.example's note that SUPABASE_PUBLISHABLE_KEY
 * is "not currently used client-side... not NEXT_PUBLIC_-prefixed yet."
 */
export const dynamic = "force-dynamic";

export default function ManagerLoginPage() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-50">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-lg font-semibold">Manager Sign In</h1>
        <p className="mt-1 text-sm text-zinc-400">Sign in with your manager or admin account.</p>
        <LoginForm supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} />
      </div>
    </div>
  );
}
