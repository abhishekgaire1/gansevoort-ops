import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Proves getAIUsageReportAction gates
// on requireAdmin() (Part 45: AI Usage & Cost is Admin-only) and that an
// invalid custom range is rejected before any aggregation query runs.

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: vi.fn(() => ({})) }));

vi.mock("@/app/lib/dateRanges/organizationTimezone", () => ({ resolveOrganizationTimezone: vi.fn(async () => "America/New_York") }));

const { getAIUsageReportMock } = vi.hoisted(() => ({
  getAIUsageReportMock: vi.fn(async () => ({
    summary: { totalCostUsd: 0, unknownCostRequestCount: 0, totalRequests: 0, successRequests: 0, failedRequests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    byTask: [],
    byModel: [],
    byProvider: [],
    recent: [],
  })),
}));
vi.mock("@/app/lib/ai/usage", () => ({ getAIUsageReport: getAIUsageReportMock }));

import { getAIUsageReportAction } from "@/app/actions/adminAIUsage";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
  getAIUsageReportMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("getAIUsageReportAction -- authorization gate", () => {
  it("rejects a non-admin (manager) caller", async () => {
    requireAdminMock.mockResolvedValue(NOT_ADMIN);
    const result = await getAIUsageReportAction("TODAY");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("not_authorized");
    expect(getAIUsageReportMock).not.toHaveBeenCalled();
  });

  it("succeeds for an admin caller and derives organizationId from the session, never the client", async () => {
    const result = await getAIUsageReportAction("TODAY");
    expect(result.ok).toBe(true);
    expect(getAIUsageReportMock).toHaveBeenCalledWith(expect.anything(), "org-1", expect.any(Date), expect.any(Date));
  });
});

describe("getAIUsageReportAction -- custom range validation", () => {
  it("rejects a custom range with start after end, before calling the aggregation query", async () => {
    const result = await getAIUsageReportAction("CUSTOM", "2026-08-20", "2026-08-01");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("invalid_range");
    expect(getAIUsageReportMock).not.toHaveBeenCalled();
  });

  it("rejects a custom range missing dates", async () => {
    const result = await getAIUsageReportAction("CUSTOM");
    expect(result.ok).toBe(false);
    expect(getAIUsageReportMock).not.toHaveBeenCalled();
  });

  it("accepts a valid custom range", async () => {
    const result = await getAIUsageReportAction("CUSTOM", "2026-08-01", "2026-08-20");
    expect(result.ok).toBe(true);
  });
});
