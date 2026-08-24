"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";

const MIN_PASSWORD_LENGTH = 8;

/**
 * Identity + Access Management milestone -- the browser client picks up
 * the recovery/invite session from the URL fragment automatically on
 * load (Supabase's own detectSessionInUrl behavior); this form only
 * needs to confirm a session exists before allowing updateUser, and show
 * a clear error if the link was invalid/expired rather than a confusing
 * blank form.
 */
export function ResetPasswordForm({ supabaseUrl, supabasePublishableKey }: { supabaseUrl: string; supabasePublishableKey: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState<boolean | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const supabase = createBrowserClient(supabaseUrl, supabasePublishableKey);
    supabase.auth.getSession().then(({ data }) => {
      setSessionReady(Boolean(data.session));
    });
  }, [supabaseUrl, supabasePublishableKey]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    setError(null);
    const supabase = createBrowserClient(supabaseUrl, supabasePublishableKey);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setPending(false);

    if (updateError) {
      setError("Unable to set your password. Try requesting a new link.");
      return;
    }
    setDone(true);
  }

  if (sessionReady === null) {
    return <p className="mt-6 text-sm text-zinc-500">Loading…</p>;
  }

  if (!sessionReady) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <p className="text-sm text-red-400">This link is invalid or has expired.</p>
        <a href="/manager/forgot-password" className="text-sm text-amber-400 hover:underline">
          Request a new link
        </a>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mt-6 flex flex-col gap-4">
        <p className="text-sm text-zinc-300">Your password has been set.</p>
        <button
          type="button"
          onClick={() => {
            router.replace("/manager/receiving");
            router.refresh();
          }}
          className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950"
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-400">New Password</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-50"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-400">Confirm Password</span>
        <input
          type="password"
          required
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-50"
        />
      </label>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 transition disabled:opacity-40"
      >
        {pending ? "Saving…" : "Set Password"}
      </button>
    </form>
  );
}
