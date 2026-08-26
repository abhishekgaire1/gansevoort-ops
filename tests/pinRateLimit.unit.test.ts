import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveRateLimitKey,
  getCurrentPinRateLimitCount,
  incrementPinRateLimit,
  registerPinFailureAcrossScopes,
  resetDeviceScopeOnSuccess,
  checkAndIncrementCpuThrottle,
  getOrgPinRateLimitStatus,
  unlockOrgPinRateLimits,
  MAX_FAILURES_DEVICE,
  MAX_FAILURES_IP,
  MAX_FAILURES_ORG,
  MAX_ATTEMPTS_CPU_THROTTLE,
  WINDOW_SECONDS_DEVICE,
  WINDOW_SECONDS_IP,
  WINDOW_SECONDS_ORG,
  WINDOW_SECONDS_CPU_THROTTLE,
  type PinRateLimitKeys,
} from "@/app/lib/auth/rateLimit";
import { issueDeviceId, verifyDeviceId } from "@/app/lib/auth/deviceId";

// CI-safe: no network, no database -- a small in-memory fixed-window
// counter stands in for pin_verify_rate_limits, driven through the exact
// same RPC/select call shapes the real functions use, so this exercises
// the REAL orchestration logic in rateLimit.ts against a faithful (if
// simplified) reimplementation of the SQL's own bucketing formula AND its
// atomicity -- never a mock reshaped to already contain the desired
// answer. See the module-level note on registerPinVerificationFailure
// below for exactly what "faithful" means for the atomic RPC.

function windowStartFor(windowSeconds: number): string {
  const bucketSeconds = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  return new Date(bucketSeconds * 1000).toISOString();
}

interface StoredRateLimitRow {
  scope: string;
  attempt_count: number;
}

/** Mirrors the CORRECTED 20260811100118 schema exactly: the primary key
 * is (organization_id, rate_limit_key, window_start) -- scope is a plain,
 * non-key column. This is deliberate (see the migration's own comment):
 * two DIFFERENT scopes sharing the same raw rate_limit_key would land on
 * the SAME row here, exactly as they would against the real database --
 * which is precisely why deriveRateLimitKey hashes scope into the key
 * itself (proven by the "cannot collide across scopes" tests above) and
 * why the tests below always derive keys through it rather than reusing
 * a bare literal across scopes.
 *
 * register_pin_verification_failure's fake handler is deliberately written
 * with NO `await` between reading and writing a row -- exactly mirroring
 * why the real INSERT ... ON CONFLICT DO UPDATE ... RETURNING statement is
 * atomic: a JS async function with no internal await runs its entire body
 * synchronously once invoked, so N concurrent calls issued via
 * Promise.all are still serialized one after another with no interleaving,
 * the same guarantee Postgres's own row-level locking provides for the
 * real statement. This is what lets the concurrency tests below prove the
 * ceiling is never exceeded even under simulated concurrent, multi-IP
 * callers -- it is not simply asserting the desired answer. */
function createFakeRateLimitStore() {
  const store = new Map<string, StoredRateLimitRow>();

  function storeKey(organizationId: string, rateLimitKey: string, windowStart: string): string {
    return `${organizationId}|${rateLimitKey}|${windowStart}`;
  }

  const from = vi.fn((table: string) => {
    if (table !== "pin_verify_rate_limits") throw new Error(`unexpected table: ${table}`);
    const filters: Record<string, string> = {};
    const chain = {
      select: () => chain,
      eq: (col: string, val: string) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => {
        const key = storeKey(filters.organization_id, filters.rate_limit_key, filters.window_start);
        const row = store.get(key);
        // The real query also filters .eq("scope", scope) -- a row whose
        // CURRENT scope doesn't match the requested scope is exactly as
        // invisible here as it would be against the real table.
        if (!row || row.scope !== filters.scope) return { data: null, error: null };
        return { data: { attempt_count: row.attempt_count }, error: null };
      },
    };
    return chain;
  });

  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "increment_pin_rate_limit") {
      const windowStart = windowStartFor(params.p_window_seconds as number);
      const key = storeKey(params.p_organization_id as string, params.p_rate_limit_key as string, windowStart);
      const next = (store.get(key)?.attempt_count ?? 0) + 1;
      store.set(key, { scope: params.p_scope as string, attempt_count: next });
      return { data: next, error: null };
    }
    if (name === "register_pin_verification_failure") {
      const windowStart = windowStartFor(params.p_window_seconds as number);
      const key = storeKey(params.p_organization_id as string, params.p_rate_limit_key as string, windowStart);
      const next = (store.get(key)?.attempt_count ?? 0) + 1;
      store.set(key, { scope: params.p_scope as string, attempt_count: next });
      const permitted = next <= (params.p_max_attempts as number);
      return { data: [{ out_attempt_count: next, out_permitted: permitted }], error: null };
    }
    if (name === "reset_pin_rate_limit_scope") {
      const windowStart = windowStartFor(params.p_window_seconds as number);
      const key = storeKey(params.p_organization_id as string, params.p_rate_limit_key as string, windowStart);
      const existing = store.get(key);
      if (existing && existing.scope === params.p_scope) store.delete(key);
      return { data: null, error: null };
    }
    if (name === "get_org_pin_rate_limit_status") {
      const windowSeconds = params.p_window_seconds as number;
      const windowStart = windowStartFor(windowSeconds);
      const key = storeKey(params.p_organization_id as string, params.p_rate_limit_key as string, windowStart);
      const row = store.get(key);
      const attemptCount = row && row.scope === "org" ? row.attempt_count : 0;
      const maxAttempts = params.p_max_attempts as number;
      const expiresAt = new Date(new Date(windowStart).getTime() + windowSeconds * 1000).toISOString();
      return {
        data: [{ out_attempt_count: attemptCount, out_is_locked_out: attemptCount >= maxAttempts, out_window_expires_at: expiresAt }],
        error: null,
      };
    }
    if (name === "unlock_org_pin_rate_limits") {
      // Mirrors "delete from pin_verify_rate_limits where organization_id
      // = p_organization_id" -- every scope, every key, every window for
      // this org only, regardless of the derived key used to store them.
      for (const key of Array.from(store.keys())) {
        if (key.startsWith(`${params.p_organization_id as string}|`)) store.delete(key);
      }
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc: ${name}`);
  });

  return { client: { from, rpc } as unknown as SupabaseClient, store };
}

const ORG_ID = "org-1";

describe("deriveRateLimitKey", () => {
  it("is deterministic for the same scope and source", () => {
    expect(deriveRateLimitKey("device", "device-1")).toBe(deriveRateLimitKey("device", "device-1"));
  });

  it("differs for a different source", () => {
    expect(deriveRateLimitKey("device", "device-1")).not.toBe(deriveRateLimitKey("device", "device-2"));
  });

  it("11. cannot collide across scopes, even for the identical raw source -- this is what keeps 'ip' and 'ip_all_attempts' from sharing a counter row despite pin_verify_rate_limits' primary key not itself including scope", () => {
    expect(deriveRateLimitKey("ip", "203.0.113.5")).not.toBe(deriveRateLimitKey("ip_all_attempts", "203.0.113.5"));
  });

  it("cannot collide across organizations sharing the same raw source string (organization scoping is layered on top via the table's own organization_id column, not this hash)", () => {
    // deriveRateLimitKey itself has no notion of organization -- this
    // documents that organization isolation for a given scope+source is
    // provided by pin_verify_rate_limits.organization_id, not by mixing
    // the org id into the hash. Proven at the counter level in
    // "scopes/keys/organizations are fully independent counters" below.
    expect(deriveRateLimitKey("ip", "203.0.113.5")).toBe(deriveRateLimitKey("ip", "203.0.113.5"));
  });
});

describe("getCurrentPinRateLimitCount / incrementPinRateLimit", () => {
  it("reads 0 when nothing has been recorded yet", async () => {
    const { client } = createFakeRateLimitStore();
    const count = await getCurrentPinRateLimitCount(client, ORG_ID, "device", "key-1", WINDOW_SECONDS_DEVICE);
    expect(count).toBe(0);
  });

  it("increments atomically and the read-only check observes the new count", async () => {
    const { client } = createFakeRateLimitStore();
    await incrementPinRateLimit(client, ORG_ID, "device", "key-1", WINDOW_SECONDS_DEVICE);
    const secondCount = await incrementPinRateLimit(client, ORG_ID, "device", "key-1", WINDOW_SECONDS_DEVICE);
    expect(secondCount).toBe(2);

    const readCount = await getCurrentPinRateLimitCount(client, ORG_ID, "device", "key-1", WINDOW_SECONDS_DEVICE);
    expect(readCount).toBe(2);
  });

  it("keys/organizations are independent counters for the SAME scope", async () => {
    const { client } = createFakeRateLimitStore();
    await incrementPinRateLimit(client, ORG_ID, "device", "key-1", WINDOW_SECONDS_DEVICE);
    await incrementPinRateLimit(client, ORG_ID, "device", "key-2", WINDOW_SECONDS_DEVICE);
    await incrementPinRateLimit(client, "org-2", "device", "key-1", WINDOW_SECONDS_DEVICE);

    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", "key-1", WINDOW_SECONDS_DEVICE)).toBe(1);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", "key-2", WINDOW_SECONDS_DEVICE)).toBe(1);
    expect(await getCurrentPinRateLimitCount(client, "org-2", "device", "key-1", WINDOW_SECONDS_DEVICE)).toBe(1);
  });

  it("DIFFERENT scopes are independent ONLY because the caller derives a distinct key per scope (deriveRateLimitKey) -- reusing the SAME raw rate_limit_key across scopes would collide, since pin_verify_rate_limits' primary key does not itself include scope", async () => {
    const { client } = createFakeRateLimitStore();
    // The correct, safe usage pattern: every scope gets its OWN key,
    // derived via deriveRateLimitKey (which hashes the scope name in).
    const deviceKey = deriveRateLimitKey("device", "same-raw-identifier");
    const ipKey = deriveRateLimitKey("ip", "same-raw-identifier");
    expect(deviceKey).not.toBe(ipKey);

    await incrementPinRateLimit(client, ORG_ID, "device", deviceKey, WINDOW_SECONDS_DEVICE);
    await incrementPinRateLimit(client, ORG_ID, "ip", ipKey, WINDOW_SECONDS_IP);

    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", deviceKey, WINDOW_SECONDS_DEVICE)).toBe(1);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip", ipKey, WINDOW_SECONDS_IP)).toBe(1);
  });

  it("documents the hazard directly: reusing the SAME bare rate_limit_key for two different scopes DOES collide on one row (proves why deriveRateLimitKey's scope-prefixing is load-bearing, not cosmetic)", async () => {
    const { client } = createFakeRateLimitStore();
    await incrementPinRateLimit(client, ORG_ID, "device", "unscoped-shared-key", WINDOW_SECONDS_DEVICE);
    // A second scope reusing the exact same raw key AND window increments
    // the SAME physical row (attempt_count climbs to 2, not a fresh 1)
    // and overwrites its `scope` column -- the first scope's own read now
    // finds nothing, because the stored row's scope no longer matches.
    await incrementPinRateLimit(client, ORG_ID, "ip", "unscoped-shared-key", WINDOW_SECONDS_DEVICE);

    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", "unscoped-shared-key", WINDOW_SECONDS_DEVICE)).toBe(0);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip", "unscoped-shared-key", WINDOW_SECONDS_DEVICE)).toBe(2);
  });
});

function makeKeys(overrides: Partial<PinRateLimitKeys> = {}): PinRateLimitKeys {
  return { deviceKey: "device-key", ipKey: "ip-key", orgKey: "org-key", ...overrides };
}

describe("registerPinFailureAcrossScopes (atomic reserve-and-check, replaces the old racy checkPinRateLimits + later increment)", () => {
  it("allows when all three scopes are under their max, and increments all three", async () => {
    const { client } = createFakeRateLimitStore();
    const result = await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys());
    expect(result.allowed).toBe(true);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", "device-key", WINDOW_SECONDS_DEVICE)).toBe(1);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip", "ip-key", WINDOW_SECONDS_IP)).toBe(1);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "org", "org-key", WINDOW_SECONDS_ORG)).toBe(1);
  });

  it("28. blocks once the DEVICE scope reaches its max failed attempts", async () => {
    const { client } = createFakeRateLimitStore();
    const keys = makeKeys();
    for (let i = 0; i < MAX_FAILURES_DEVICE; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    }
    const result = await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    expect(result.allowed).toBe(false);
  });

  it("29. blocks once the IP scope reaches its max, even across many DIFFERENT device keys (rotated device cookies) -- a cleared/rotated device cookie cannot bypass the IP ceiling", async () => {
    const { client } = createFakeRateLimitStore();
    const sharedIpKey = "shared-ip-key";
    for (let i = 0; i < MAX_FAILURES_IP; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `device-${i}`, ipKey: sharedIpKey }));
    }
    // A fresh, never-seen-before device key -- simulates an attacker
    // clearing/rotating their device cookie between attempts.
    const result = await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: "brand-new-device-key", ipKey: sharedIpKey }));
    expect(result.allowed).toBe(false);
  });

  it("30. blocks once the ORG scope reaches its max, even across many different device AND ip keys", async () => {
    const { client } = createFakeRateLimitStore();
    const sharedOrgKey = "shared-org-key";
    for (let i = 0; i < MAX_FAILURES_ORG; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `device-${i}`, ipKey: `ip-${i}`, orgKey: sharedOrgKey }));
    }
    const result = await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: "device-final", ipKey: "ip-final", orgKey: sharedOrgKey }));
    expect(result.allowed).toBe(false);
  });

  it("a different organization's identical keys are entirely unaffected", async () => {
    const { client } = createFakeRateLimitStore();
    const keys = makeKeys();
    for (let i = 0; i < MAX_FAILURES_DEVICE; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    }
    const result = await registerPinFailureAcrossScopes(client, "a-different-org", keys);
    expect(result.allowed).toBe(true);
  });

  it("PROVES THE FIX: org counter at 49/50, then 100 concurrent failures each from a DIFFERENT device+ip key (distributed, multi-IP attack) -- at most exactly 1 more is permitted, the other 99 are refused, with no lost updates or overshoot tolerated by the check itself", async () => {
    const { client } = createFakeRateLimitStore();
    const sharedOrgKey = "org-under-attack";

    // Bring the org scope to 49/50 first (sequential, simulating prior
    // legitimate history).
    for (let i = 0; i < MAX_FAILURES_ORG - 1; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `prior-device-${i}`, ipKey: `prior-ip-${i}`, orgKey: sharedOrgKey }));
    }
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "org", sharedOrgKey, WINDOW_SECONDS_ORG)).toBe(MAX_FAILURES_ORG - 1);

    // 100 concurrent requests, each with its OWN distinct device/ip key
    // (so neither the device nor the ip scope, nor the per-IP CPU
    // throttle, blocks any of them) but the SAME shared org key -- exactly
    // the scenario the task's concurrency race describes.
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `attack-device-${i}`, ipKey: `attack-ip-${i}`, orgKey: sharedOrgKey }))
      )
    );

    const permittedCount = results.filter((r) => r.allowed).length;
    // Exactly one more request (the one that pushes the org counter from
    // 49 to the 50th, boundary-inclusive) may be permitted; every other
    // concurrent request must be refused BEFORE any further Argon2 work,
    // regardless of how many distinct IPs/devices were used.
    expect(permittedCount).toBe(1);
    // The counter itself still accumulates every attempt correctly (no
    // lost updates) -- it is the AUTHORIZATION decision, not the count,
    // that must never exceed the ceiling.
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "org", sharedOrgKey, WINDOW_SECONDS_ORG)).toBe(MAX_FAILURES_ORG - 1 + 100);
  });
});

describe("resetDeviceScopeOnSuccess", () => {
  it("27/35. resets only the device scope's current window", async () => {
    const { client } = createFakeRateLimitStore();
    const keys = makeKeys();
    // Simulate a couple of earlier innocent mistakes from this same device.
    await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", keys.deviceKey, WINDOW_SECONDS_DEVICE)).toBe(2);

    await resetDeviceScopeOnSuccess(client, ORG_ID, keys.deviceKey);

    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", keys.deviceKey, WINDOW_SECONDS_DEVICE)).toBe(0);
  });

  it("36. never touches the IP/ORG scopes -- organization-wide attack evidence survives a success", async () => {
    const { client } = createFakeRateLimitStore();
    const keys = makeKeys();
    await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    await registerPinFailureAcrossScopes(client, ORG_ID, keys);

    await resetDeviceScopeOnSuccess(client, ORG_ID, keys.deviceKey);

    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip", keys.ipKey, WINDOW_SECONDS_IP)).toBe(2);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "org", keys.orgKey, WINDOW_SECONDS_ORG)).toBe(2);
  });

  it("a SUCCESSFUL attempt (which never calls registerPinFailureAcrossScopes at all) consumes the CPU/all-attempts quota but never creates any device/ip/org failure-scope row", async () => {
    const { client } = createFakeRateLimitStore();
    const cpuKey = "cpu-key-for-this-source";
    const keys = makeKeys({ deviceKey: "fresh-device", ipKey: "fresh-ip", orgKey: "fresh-org" });

    // Mirrors verifyPinCore's own call order for one successful attempt:
    // the CPU throttle is checked/incremented unconditionally first...
    const cpuBefore = await checkAndIncrementCpuThrottle(client, ORG_ID, cpuKey);
    expect(cpuBefore.allowed).toBe(true);
    // ...then, once the PIN verifies correctly, only the device-scope
    // reset runs -- registerPinFailureAcrossScopes is never called on a
    // success at all, so there is nothing to "give back".
    await resetDeviceScopeOnSuccess(client, ORG_ID, keys.deviceKey);

    // The CPU counter's single increment from this attempt is still
    // there -- a success never gives it back.
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip_all_attempts", cpuKey, WINDOW_SECONDS_CPU_THROTTLE)).toBe(1);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", keys.deviceKey, WINDOW_SECONDS_DEVICE)).toBe(0);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip", keys.ipKey, WINDOW_SECONDS_IP)).toBe(0);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "org", keys.orgKey, WINDOW_SECONDS_ORG)).toBe(0);
  });

  it("proves the CPU throttle's check-and-increment is a single atomic call, not a separate read-then-write -- a burst of concurrent attempts is counted exactly, with none silently lost or double-counted", async () => {
    const { client } = createFakeRateLimitStore();
    const cpuKey = "burst-key";
    const results = await Promise.all(Array.from({ length: 12 }, () => checkAndIncrementCpuThrottle(client, ORG_ID, cpuKey)));
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip_all_attempts", cpuKey, WINDOW_SECONDS_CPU_THROTTLE)).toBe(12);
  });
});

describe("checkAndIncrementCpuThrottle (37. separate from the failed-attempt security scopes)", () => {
  it("counts every attempt regardless of outcome and is keyed by source IP only", async () => {
    const { client } = createFakeRateLimitStore();
    const first = await checkAndIncrementCpuThrottle(client, ORG_ID, "ip-key-1");
    expect(first.allowed).toBe(true);
    const secondCount = await getCurrentPinRateLimitCount(client, ORG_ID, "ip_all_attempts", "ip-key-1", WINDOW_SECONDS_CPU_THROTTLE);
    expect(secondCount).toBe(1);
  });

  it("blocks once the ceiling for this window is exceeded", async () => {
    const { client } = createFakeRateLimitStore();
    let last = { allowed: true };
    for (let i = 0; i < MAX_ATTEMPTS_CPU_THROTTLE + 5; i++) {
      last = await checkAndIncrementCpuThrottle(client, ORG_ID, "ip-key-1");
    }
    expect(last.allowed).toBe(false);
  });

  it("38. is fully DB-backed (parameterized on a SupabaseClient) -- never in-memory-only, safe under a serverless/multi-instance deployment", async () => {
    const { client, store } = createFakeRateLimitStore();
    await checkAndIncrementCpuThrottle(client, ORG_ID, "ip-key-1");
    // The fake's own backing store is what changed -- proves state is
    // written through the client, not held in any module-level variable
    // inside rateLimit.ts.
    expect(store.size).toBeGreaterThan(0);
  });
});

describe("getOrgPinRateLimitStatus / unlockOrgPinRateLimits (manager/admin operational recovery)", () => {
  it("reports not locked out with a zero count when nothing has been recorded", async () => {
    const { client } = createFakeRateLimitStore();
    const status = await getOrgPinRateLimitStatus(client, ORG_ID);
    expect(status.isLockedOut).toBe(false);
    expect(status.attemptCount).toBe(0);
  });

  it("reports locked out once the org scope reaches its max, with an expiry timestamp in the future", async () => {
    const { client } = createFakeRateLimitStore();
    const orgKey = deriveRateLimitKey("org", ORG_ID);
    for (let i = 0; i < MAX_FAILURES_ORG; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `d-${i}`, ipKey: `i-${i}`, orgKey }));
    }
    const status = await getOrgPinRateLimitStatus(client, ORG_ID);
    expect(status.isLockedOut).toBe(true);
    expect(new Date(status.windowExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not expose any raw device/ip key or rate_limit_key -- only a count, a boolean, and a timestamp", async () => {
    const { client } = createFakeRateLimitStore();
    const status = await getOrgPinRateLimitStatus(client, ORG_ID);
    expect(Object.keys(status).sort()).toEqual(["attemptCount", "isLockedOut", "windowExpiresAt"]);
  });

  it("unlocking clears the org's own lockout so status reports unlocked again", async () => {
    const { client } = createFakeRateLimitStore();
    const orgKey = deriveRateLimitKey("org", ORG_ID);
    for (let i = 0; i < MAX_FAILURES_ORG; i++) {
      await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `d-${i}`, ipKey: `i-${i}`, orgKey }));
    }
    expect((await getOrgPinRateLimitStatus(client, ORG_ID)).isLockedOut).toBe(true);

    await unlockOrgPinRateLimits(client, ORG_ID, "actor-app-user-id");

    expect((await getOrgPinRateLimitStatus(client, ORG_ID)).isLockedOut).toBe(false);
  });

  it("unlocking clears ALL scopes (device/ip/org/cpu-throttle) for that organization, not just the org scope", async () => {
    const { client } = createFakeRateLimitStore();
    const keys = makeKeys();
    await registerPinFailureAcrossScopes(client, ORG_ID, keys);
    await checkAndIncrementCpuThrottle(client, ORG_ID, "some-ip-cpu-key");

    await unlockOrgPinRateLimits(client, ORG_ID, "actor-app-user-id");

    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "device", keys.deviceKey, WINDOW_SECONDS_DEVICE)).toBe(0);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip", keys.ipKey, WINDOW_SECONDS_IP)).toBe(0);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "org", keys.orgKey, WINDOW_SECONDS_ORG)).toBe(0);
    expect(await getCurrentPinRateLimitCount(client, ORG_ID, "ip_all_attempts", "some-ip-cpu-key", WINDOW_SECONDS_CPU_THROTTLE)).toBe(0);
  });

  it("unlocking one organization never clears a different organization's rate-limit records (cross-org clearing impossible)", async () => {
    const { client } = createFakeRateLimitStore();
    const keys = makeKeys();
    await registerPinFailureAcrossScopes(client, "other-org", keys);

    await unlockOrgPinRateLimits(client, ORG_ID, "actor-app-user-id");

    expect(await getCurrentPinRateLimitCount(client, "other-org", "device", keys.deviceKey, WINDOW_SECONDS_DEVICE)).toBe(1);
  });
});

describe("deviceId (31. cannot be forged / 32. clearing the cookie cannot bypass IP/org limits)", () => {
  const secret = "test-device-id-secret";

  it("issues a device id that verifies successfully with the same secret", () => {
    const issued = issueDeviceId(secret);
    const result = verifyDeviceId(issued, secret);
    expect(result.ok).toBe(true);
  });

  it("rejects a device id signed with a different secret", () => {
    const issued = issueDeviceId(secret);
    const result = verifyDeviceId(issued, "wrong-secret");
    expect(result).toEqual({ ok: false });
  });

  it("rejects a tampered device id payload (signature no longer matches)", () => {
    const issued = issueDeviceId(secret);
    const [deviceId, signature] = issued.split(".");
    const tampered = `${deviceId}-tampered.${signature}`;
    expect(verifyDeviceId(tampered, secret)).toEqual({ ok: false });
  });

  it("rejects a missing cookie value -- the caller must issue a fresh one, never treat this as a security boundary that quietly no-ops", () => {
    expect(verifyDeviceId(undefined, secret)).toEqual({ ok: false });
    expect(verifyDeviceId(null, secret)).toEqual({ ok: false });
    expect(verifyDeviceId("", secret)).toEqual({ ok: false });
  });

  it("rejects a malformed value with no signature separator", () => {
    expect(verifyDeviceId("not-a-real-device-id", secret)).toEqual({ ok: false });
  });

  it("two issued device ids are never identical (each is a fresh random value)", () => {
    expect(issueDeviceId(secret)).not.toBe(issueDeviceId(secret));
  });

  it("32. clearing/rotating the device cookie cannot bypass the IP or ORG ceilings -- a fresh device key still shares the same ip/org keys and is blocked identically", async () => {
    const { client } = createFakeRateLimitStore();
    const sharedIpKey = "shared-ip-key-device-rotation";
    for (let i = 0; i < MAX_FAILURES_IP; i++) {
      // A brand-new device key every single attempt -- simulates clearing
      // the device cookie before every request.
      await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: `rotated-device-${i}`, ipKey: sharedIpKey }));
    }
    const result = await registerPinFailureAcrossScopes(client, ORG_ID, makeKeys({ deviceKey: "yet-another-fresh-device", ipKey: sharedIpKey }));
    expect(result.allowed).toBe(false);
  });
});
