"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Identity + Access Management milestone, Part 19/20 -- self-service
 * password recovery via Supabase Auth's own resetPasswordForEmail, a
 * direct client-side call (same pattern LoginForm already uses -- no
 * privileged/service-role operation is needed here at all). The
 * confirmation message is deliberately identical whether or not an
 * account exists for the entered email, to avoid account enumeration
 * (Part 20) -- Supabase's own resetPasswordForEmail already doesn't leak
 * existence via its response, so this just never branches on it either.
 */
export function ForgotPasswordForm({ supabaseUrl, supabasePublishableKey }: { supabaseUrl: string; supabasePublishableKey: string }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !email.trim()) return;
    setPending(true);

    const supabase = createBrowserClient(supabaseUrl, supabasePublishableKey);
    await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/manager/reset-password` });

    setPending(false);
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-zinc-300">If an account exists for that email, a password reset link has been sent.</p>
        <Link href="/manager/login" className="text-sm text-amber-400 hover:underline">
          ← Back to Sign In
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-400">Email</span>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-50"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 transition disabled:opacity-40"
      >
        {pending ? "Sending…" : "Send Reset Link"}
      </button>
      <Link href="/manager/login" className="text-center text-sm text-zinc-500 hover:text-zinc-300">
        ← Back to Sign In
      </Link>
    </form>
  );
}
