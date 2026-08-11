import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client authenticated with the secret key (the 2026
 * Supabase API key scheme's replacement for the legacy service_role key --
 * requests made with it still execute with the built-in service_role
 * Postgres privileges, which is why the RPC grant in the migration targets
 * service_role and needs no change).
 *
 * This bypasses RLS entirely, which is why RLS on every table in this
 * schema is deny-by-default: all authoritative reads/writes flow through
 * trusted server code using this client, never a direct browser connection.
 * The "server-only" import above makes it a build error to pull this module
 * into any client-bundled code.
 */
let cachedClient: SupabaseClient | null = null;

export function getServiceRoleClient(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url) {
    throw new Error("SUPABASE_URL is not set");
  }
  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is not set");
  }

  cachedClient = createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return cachedClient;
}
