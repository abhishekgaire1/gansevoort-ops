import { ResetPasswordForm } from "./_components/ResetPasswordForm";

/**
 * The single landing page for BOTH invite-acceptance and self-service/
 * Admin-triggered password recovery (Identity + Access Management
 * milestone, Part 19/21/23) -- Supabase's email link redirects here with
 * a session established via the URL fragment; this page's only job is
 * asking for (and confirming) a new password via supabase.auth.
 * updateUser, identical regardless of how the user arrived.
 */
export const dynamic = "force-dynamic";

export default function ResetPasswordPage() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-50">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-lg font-semibold">Set Your Password</h1>
        <p className="mt-1 text-sm text-zinc-400">Choose a password for your account.</p>
        <ResetPasswordForm supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} />
      </div>
    </div>
  );
}
