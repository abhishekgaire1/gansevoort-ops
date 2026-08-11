import { describe, expect, it } from "vitest";
import {
  KIOSK_SESSION_MAX_SECONDS,
  KIOSK_TOKEN_TTL_SECONDS,
  RECENT_ACTIVITY_WINDOW_SECONDS,
  REFRESH_AT_TOKEN_AGE_SECONDS,
  decideSessionTick,
} from "@/app/kiosk/_lib/sessionRefresh";

// CI-safe: pure logic, no network, no database. All timestamps below are in
// seconds, matching decideSessionTick's contract.

describe("decideSessionTick", () => {
  it("noop when the token is fresh and the employee was recently active", () => {
    const decision = decideSessionTick({
      now: 1000,
      tokenClientIssuedAt: 990,
      sessionStartedAtClient: 990,
      lastActivityAt: 995,
    });
    expect(decision).toBe("noop");
  });

  it("refresh once the token is old enough AND the employee was recently active", () => {
    const decision = decideSessionTick({
      now: 1000,
      tokenClientIssuedAt: 1000 - REFRESH_AT_TOKEN_AGE_SECONDS,
      sessionStartedAtClient: 1000 - REFRESH_AT_TOKEN_AGE_SECONDS,
      lastActivityAt: 1000 - RECENT_ACTIVITY_WINDOW_SECONDS,
    });
    expect(decision).toBe("refresh");
  });

  it("does NOT refresh when the token is old enough but the employee has gone idle", () => {
    const decision = decideSessionTick({
      now: 1000,
      tokenClientIssuedAt: 1000 - REFRESH_AT_TOKEN_AGE_SECONDS,
      sessionStartedAtClient: 1000 - REFRESH_AT_TOKEN_AGE_SECONDS,
      lastActivityAt: 1000 - RECENT_ACTIVITY_WINDOW_SECONDS - 1,
    });
    expect(decision).toBe("noop");
  });

  it("expire_idle once the token's own TTL has fully elapsed, even if the session ceiling hasn't been hit", () => {
    const decision = decideSessionTick({
      now: 1000,
      tokenClientIssuedAt: 1000 - KIOSK_TOKEN_TTL_SECONDS,
      sessionStartedAtClient: 1000 - KIOSK_TOKEN_TTL_SECONDS,
      lastActivityAt: 1000 - KIOSK_TOKEN_TTL_SECONDS,
    });
    expect(decision).toBe("expire_idle");
  });

  it("expire_ceiling once the absolute session ceiling has elapsed, even with a fresh token and recent activity", () => {
    const decision = decideSessionTick({
      now: 1000,
      tokenClientIssuedAt: 999, // token itself is brand new
      sessionStartedAtClient: 1000 - KIOSK_SESSION_MAX_SECONDS,
      lastActivityAt: 999,
    });
    expect(decision).toBe("expire_ceiling");
  });

  it("expire_ceiling takes priority over expire_idle when both thresholds are simultaneously exceeded", () => {
    const decision = decideSessionTick({
      now: 1000,
      tokenClientIssuedAt: 1000 - KIOSK_TOKEN_TTL_SECONDS - 1,
      sessionStartedAtClient: 1000 - KIOSK_SESSION_MAX_SECONDS - 1,
      lastActivityAt: 1000 - KIOSK_TOKEN_TTL_SECONDS - 1,
    });
    expect(decision).toBe("expire_ceiling");
  });
});
