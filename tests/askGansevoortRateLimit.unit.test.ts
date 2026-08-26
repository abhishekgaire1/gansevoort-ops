import { describe, expect, it, vi } from "vitest";
import { checkAskGansevoortRateLimit } from "@/app/lib/ai/chatRateLimit";

// CI-safe: pure logic over a mocked Supabase RPC call -- no network, no
// database. Proves the rate-limit IDENTITY always comes from the
// server-supplied appUserId/organizationId arguments (there is no other
// input this function could possibly derive identity from), and that
// exceeding either the per-manager or per-organization ceiling is
// rejected.

function fakeSupabase(countsByKey: Record<string, number>) {
  return {
    rpc: vi.fn(async (_name: string, params: { p_rate_limit_key: string }) => ({ data: countsByKey[params.p_rate_limit_key] ?? 1, error: null })),
  };
}

describe("checkAskGansevoortRateLimit", () => {
  it("allows a request comfortably under both ceilings", async () => {
    const supabase = fakeSupabase({ "askg:user:app-user-1": 3, "askg:org:org-1": 5 });
    const result = await checkAskGansevoortRateLimit(supabase as never, "org-1", "app-user-1");
    expect(result).toEqual({ allowed: true });
  });

  it("rejects once the per-manager ceiling (10 per 5 minutes) is exceeded", async () => {
    const supabase = fakeSupabase({ "askg:user:app-user-1": 11, "askg:org:org-1": 11 });
    const result = await checkAskGansevoortRateLimit(supabase as never, "org-1", "app-user-1");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rejects once the per-organization ceiling (40 per 5 minutes) is exceeded even if the individual manager is under their own limit", async () => {
    const supabase = fakeSupabase({ "askg:user:app-user-1": 2, "askg:org:org-1": 41 });
    const result = await checkAskGansevoortRateLimit(supabase as never, "org-1", "app-user-1");
    expect(result.allowed).toBe(false);
  });

  it("derives its rate-limit key ONLY from the function's own organizationId/appUserId parameters -- there is no client-header or IP input anywhere in its signature", async () => {
    const supabase = fakeSupabase({});
    await checkAskGansevoortRateLimit(supabase as never, "org-A", "user-A");
    const calledKeys = (supabase.rpc as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1].p_rate_limit_key);
    expect(calledKeys).toEqual(expect.arrayContaining(["askg:user:user-A", "askg:org:org-A"]));
    expect(checkAskGansevoortRateLimit.length).toBe(3);
  });

  it("keeps separate organizations fully isolated from one another's counters", async () => {
    const supabase = fakeSupabase({ "askg:org:org-A": 41, "askg:org:org-B": 1, "askg:user:user-1": 1 });
    const resultA = await checkAskGansevoortRateLimit(supabase as never, "org-A", "user-1");
    const resultB = await checkAskGansevoortRateLimit(supabase as never, "org-B", "user-1");
    expect(resultA.allowed).toBe(false);
    expect(resultB.allowed).toBe(true);
  });

  it("propagates a genuine RPC failure rather than silently allowing the request through", async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: { message: "db unavailable" } })) };
    await expect(checkAskGansevoortRateLimit(supabase as never, "org-1", "app-user-1")).rejects.toThrow();
  });
});
