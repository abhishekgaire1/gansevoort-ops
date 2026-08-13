import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveCanonicalOrgId, ensureCanonicalOrgId } from "@/scripts/lib/canonicalOrg";

// CI-safe: no network, no database. Covers the pure canonical-selection
// logic behind the fix for the org-fragmentation bug (organizations.name
// has no unique constraint, so a naive find-or-insert can race across
// concurrently-running .rpc.test.ts files and silently create more than
// one row with the same name -- see scripts/lib/canonicalOrg.ts and
// scripts/test-integration-setup.ts).
//
// What this file CANNOT prove: that running `npm run test:integration`
// against a genuinely fresh, empty database never produces two "TEST RPC
// Fixture Org" rows in practice. That would require either a disposable
// Supabase project or destroying/recreating the linked DEV project, both
// out of scope here (we're deliberately not doing that -- see the DEV
// cleanup plan). What this file DOES prove is the actual mechanism that
// makes that outcome structurally impossible now: (1) the resolve query is
// always ordered oldest-first with limit 1, so however many rows exist,
// exactly one is ever treated as canonical; (2) ensureCanonicalOrgId only
// inserts when the resolve step found nothing, and re-resolves afterward
// rather than trusting its own insert, so even a hypothetical race lands
// on the same oldest row every caller would agree on; and (3) the regular
// test-fixture path (resolveTestOrgId) never calls insert at all, which is
// what actually eliminates the race in practice by moving the one unsafe
// insert out of Vitest's concurrent workers and into a single serial
// script that runs before them (scripts/test-integration-setup.ts, wired
// into `npm run test:integration` ahead of `vitest run`).

interface Call {
  method: string;
  args: unknown[];
}

function createSupabaseMock(opts: { maybeSingleQueue: (Record<string, unknown> | null)[]; insertError?: unknown }) {
  const queue = [...opts.maybeSingleQueue];
  const calls: Call[] = [];
  let insertCount = 0;

  const from = vi.fn((table: string) => {
    const record = (method: string, args: unknown[]) => calls.push({ method: `${table}.${method}`, args });
    const chain = {
      select: vi.fn((...args: unknown[]) => {
        record("select", args);
        return chain;
      }),
      eq: vi.fn((...args: unknown[]) => {
        record("eq", args);
        return chain;
      }),
      order: vi.fn((...args: unknown[]) => {
        record("order", args);
        return chain;
      }),
      limit: vi.fn((...args: unknown[]) => {
        record("limit", args);
        return chain;
      }),
      maybeSingle: vi.fn(async () => {
        record("maybeSingle", []);
        const data = queue.shift() ?? null;
        return { data, error: null };
      }),
      insert: vi.fn((row: unknown) => {
        insertCount++;
        record("insert", [row]);
        return Promise.resolve({ error: opts.insertError ?? null });
      }),
    };
    return chain;
  });

  return { client: { from } as unknown as SupabaseClient, calls, from, getInsertCount: () => insertCount };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveCanonicalOrgId", () => {
  it("zero matching orgs -> returns null without inserting", async () => {
    const { client, calls, from } = createSupabaseMock({ maybeSingleQueue: [null] });
    const result = await resolveCanonicalOrgId(client, "TEST RPC Fixture Org");
    expect(result).toBeNull();
    expect(calls.some((c) => c.method === "organizations.insert")).toBe(false);
    expect(from).toHaveBeenCalledWith("organizations");
  });

  it("one matching org -> returns its id", async () => {
    const { client } = createSupabaseMock({ maybeSingleQueue: [{ id: "org-1" }] });
    const result = await resolveCanonicalOrgId(client, "TEST RPC Fixture Org");
    expect(result).toBe("org-1");
  });

  it("always queries ordered oldest-first with limit 1 -- the mechanism that makes 'multiple historical rows -> oldest wins' correct however many rows actually exist", async () => {
    const { client, calls } = createSupabaseMock({ maybeSingleQueue: [{ id: "oldest-org" }] });
    const result = await resolveCanonicalOrgId(client, "TEST RPC Fixture Org");
    expect(result).toBe("oldest-org");
    expect(calls).toContainEqual({ method: "organizations.eq", args: ["name", "TEST RPC Fixture Org"] });
    expect(calls).toContainEqual({ method: "organizations.order", args: ["created_at", { ascending: true }] });
    expect(calls).toContainEqual({ method: "organizations.limit", args: [1] });
  });
});

describe("ensureCanonicalOrgId", () => {
  it("zero matching orgs -> inserts exactly once, then re-resolves to the row that now exists", async () => {
    const { client, getInsertCount } = createSupabaseMock({
      maybeSingleQueue: [null, { id: "newly-created-org" }],
    });
    const result = await ensureCanonicalOrgId(client, "TEST RPC Fixture Org");
    expect(result).toBe("newly-created-org");
    expect(getInsertCount()).toBe(1);
  });

  it("one matching org already exists -> reuses it without inserting", async () => {
    const { client, getInsertCount } = createSupabaseMock({ maybeSingleQueue: [{ id: "existing-org" }] });
    const result = await ensureCanonicalOrgId(client, "TEST RPC Fixture Org");
    expect(result).toBe("existing-org");
    expect(getInsertCount()).toBe(0);
  });

  it("multiple historical matching orgs -> the oldest (first resolved) row is reused, no additional row is created", async () => {
    // The mock can only simulate "the DB already resolved to the oldest of
    // several rows" (real ordering is Postgres's job, proven in
    // resolveCanonicalOrgId's own query-shape assertions above) -- what
    // this proves is that ensureCanonicalOrgId, given that answer, never
    // second-guesses it by inserting anyway.
    const { client, getInsertCount } = createSupabaseMock({ maybeSingleQueue: [{ id: "oldest-of-several" }] });
    const result = await ensureCanonicalOrgId(client, "TEST RPC Fixture Org");
    expect(result).toBe("oldest-of-several");
    expect(getInsertCount()).toBe(0);
  });

  it("throws if a row was inserted but somehow cannot be re-selected afterward", async () => {
    const { client } = createSupabaseMock({ maybeSingleQueue: [null, null] });
    await expect(ensureCanonicalOrgId(client, "TEST RPC Fixture Org")).rejects.toThrow(/could not re-select/);
  });
});

describe("resolveTestOrgId (tests/testFixtures.ts) -- the regular fixture lookup never inserts an organization", () => {
  it("resolves the organization and its location without ever calling insert", async () => {
    const { resolveTestOrgId } = await import("./testFixtures");
    const { client, calls } = createSupabaseMock({ maybeSingleQueue: [{ id: "org-1" }, { id: "location-1" }] });

    const result = await resolveTestOrgId(client);

    expect(result).toEqual({ organizationId: "org-1", locationId: "location-1" });
    expect(calls.some((c) => c.method.endsWith(".insert"))).toBe(false);
  });

  it("throws a clear, actionable error when no organization exists yet (setup script was never run)", async () => {
    const { resolveTestOrgId } = await import("./testFixtures");
    const { client } = createSupabaseMock({ maybeSingleQueue: [null] });

    await expect(resolveTestOrgId(client)).rejects.toThrow(/test-integration-setup\.ts/);
  });

  it("throws a clear, actionable error when the organization exists but has no location yet", async () => {
    const { resolveTestOrgId } = await import("./testFixtures");
    const { client } = createSupabaseMock({ maybeSingleQueue: [{ id: "org-1" }, null] });

    await expect(resolveTestOrgId(client)).rejects.toThrow(/test-integration-setup\.ts/);
  });
});
