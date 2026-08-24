import { ForgotPasswordForm } from "./_components/ForgotPasswordForm";

/**
 * Self-service password recovery (Identity + Access Management
 * milestone, Part 19) -- outside the auth-guarded route group, same
 * reasoning as /manager/login. Reuses Supabase Auth's own
 * resetPasswordForEmail, never a custom token system.
 */
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-zinc-50">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-lg font-semibold">Reset Your Password</h1>
        <p className="mt-1 text-sm text-zinc-400">Enter your email and we&apos;ll send you a link to reset your password.</p>
        <ForgotPasswordForm supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} />
      </div>
    </div>
  );
}
