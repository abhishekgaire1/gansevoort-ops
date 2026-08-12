"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";

/**
 * Sign-out, unlike requireManagerOrAdmin()'s deliberately read-only
 * session client, needs a WRITABLE cookie jar to actually clear the
 * session -- a separate client construction, not a change to
 * app/lib/auth/managerAuth.ts, which has no business owning cookie writes.
 */
export async function signOutManager(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      },
    },
  });

  await supabase.auth.signOut();
  redirect("/manager/login");
}
