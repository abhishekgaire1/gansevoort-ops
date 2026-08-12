"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Sign-in is a direct client-side Supabase Auth call, not a Server Action:
 * @supabase/ssr's browser client persists the resulting session via cookies
 * in exactly the shape requireManagerOrAdmin()'s read-only server client
 * already reads -- this is Supabase's standard SSR auth pattern, not a new
 * mechanism invented for this app.
 */
export function LoginForm({ supabaseUrl, supabasePublishableKey }: { supabaseUrl: string; supabasePublishableKey: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    const supabase = createBrowserClient(supabaseUrl, supabasePublishableKey);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setPending(false);
      setError("Incorrect email or password.");
      return;
    }

    // Full navigation (not router.push) so the server-rendered /manager/(app)
    // layout re-reads the now-set session cookies on the very next request.
    router.replace("/manager/receiving");
    router.refresh();
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
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-400">Password</span>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-50"
        />
      </label>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 transition disabled:opacity-40"
      >
        {pending ? "Signing in…" : "Sign In"}
      </button>
    </form>
  );
}
