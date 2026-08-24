import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database, no real provider calls. Proves every
// Admin AI Configuration Server Action gates on requireAdmin() (Part 3,
// 73) and that model-allowlist/task-compatibility validation happens
// server-side before either configuration RPC is ever reached (Part 47).

const { requireAdminMock } = vi.hoisted(() => ({ requireAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireAdmin: requireAdminMock }));

vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: vi.fn(() => ({})) }));

const aiAdminLib = vi.hoisted(() => ({
  getAIOrganizationConfiguration: vi.fn(async () => ({
    organizationDefault: { provider: "gemini", model: "gemini-3.6-flash" },
    effectiveDefault: { provider: "gemini", model: "gemini-3.6-flash" },
    defaultSource: "organization_default" as const,
    tasks: [],
  })),
  setAIDefaultConfiguration: vi.fn(async () => undefined),
  setAITaskConfiguration: vi.fn(async () => undefined),
}));
vi.mock("@/app/lib/ai/admin", () => aiAdminLib);

const { isProviderConfiguredMock } = vi.hoisted(() => ({ isProviderConfiguredMock: vi.fn(() => true) }));
vi.mock("@/app/lib/ai/router/providerRegistry", () => ({ isProviderConfigured: isProviderConfiguredMock }));

const { executeAITaskMock, AIProviderUnavailableErrorMock } = vi.hoisted(() => {
  class AIProviderUnavailableErrorMock extends Error {}
  return { executeAITaskMock: vi.fn(async () => ({ ok: true })), AIProviderUnavailableErrorMock };
});
vi.mock("@/app/lib/ai/router/executeAITask", () => ({ executeAITask: executeAITaskMock, AIProviderUnavailableError: AIProviderUnavailableErrorMock }));

import { getAIConfigurationAction, saveAIDefaultConfigurationAction, saveAITaskConfigurationAction, testAIConfigurationAction } from "@/app/actions/adminAI";

const ADMIN = { ok: true as const, manager: { appUserId: "admin-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager", "admin"] } };
const NOT_ADMIN = { ok: false as const, reason: "not_authorized" as const };
const NOT_AUTHENTICATED = { ok: false as const, reason: "not_authenticated" as const };

beforeEach(() => {
  requireAdminMock.mockReset().mockResolvedValue(ADMIN);
  isProviderConfiguredMock.mockReset().mockReturnValue(true);
  executeAITaskMock.mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Admin AI Configuration actions -- authorization gate", () => {
  const cases: { name: string; call: () => Promise<{ ok: boolean }> }[] = [
    { name: "getAIConfigurationAction", call: () => getAIConfigurationAction() },
    { name: "saveAIDefaultConfigurationAction", call: () => saveAIDefaultConfigurationAction("gemini", "gemini-3.6-flash") },
    { name: "saveAITaskConfigurationAction", call: () => saveAITaskConfigurationAction("INVOICE_EXTRACTION", "gemini", "gemini-3.6-flash") },
    { name: "testAIConfigurationAction", call: () => testAIConfigurationAction("gemini", "gemini-3.6-flash") },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a non-admin (manager) caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_ADMIN);
      const result = await call();
      expect(result.ok).toBe(false);
      expect((result as { reason?: string }).reason).toBe("not_authorized");
    });

    it(`${name} rejects an unauthenticated caller`, async () => {
      requireAdminMock.mockResolvedValue(NOT_AUTHENTICATED);
      const result = await call();
      expect(result.ok).toBe(false);
    });

    it(`${name} succeeds for an admin caller`, async () => {
      const result = await call();
      expect(result.ok).toBe(true);
    });
  }
});

describe("saveAIDefaultConfigurationAction -- rejects a non-allowlisted model before calling the RPC layer", () => {
  it("returns a clean validation error, never calls setAIDefaultConfiguration", async () => {
    const result = await saveAIDefaultConfigurationAction("gemini", "gemini-9000-ultra");
    expect(result.ok).toBe(false);
    expect(aiAdminLib.setAIDefaultConfiguration).not.toHaveBeenCalled();
  });
});

describe("saveAITaskConfigurationAction -- task/model compatibility + Use Default", () => {
  it("rejects an unsupported task key", async () => {
    const result = await saveAITaskConfigurationAction("NOT_A_REAL_TASK", "gemini", "gemini-3.6-flash");
    expect(result.ok).toBe(false);
    expect(aiAdminLib.setAITaskConfiguration).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted model for a real task", async () => {
    const result = await saveAITaskConfigurationAction("ITEM_CLASSIFICATION", "gemini", "gemini-9000-ultra");
    expect(result.ok).toBe(false);
    expect(aiAdminLib.setAITaskConfiguration).not.toHaveBeenCalled();
  });

  it("provider/model both null -- 'Use Default' -- is accepted without a compatibility check", async () => {
    const result = await saveAITaskConfigurationAction("ITEM_CLASSIFICATION", null, null);
    expect(result.ok).toBe(true);
    expect(aiAdminLib.setAITaskConfiguration).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "ITEM_CLASSIFICATION", null, null);
  });

  it("passes organizationId/actorAppUserId derived from requireAdmin(), never client-supplied", async () => {
    await saveAITaskConfigurationAction("INVOICE_EXTRACTION", "gemini", "gemini-3.6-flash");
    expect(aiAdminLib.setAITaskConfiguration).toHaveBeenCalledWith(expect.anything(), "org-1", "admin-1", "INVOICE_EXTRACTION", "gemini", "gemini-3.6-flash");
  });
});

describe("testAIConfigurationAction -- provider-unavailable short-circuits before any provider call", () => {
  it("returns 'unavailable' without calling executeAITask when server credentials are missing", async () => {
    isProviderConfiguredMock.mockReturnValue(false);
    const result = await testAIConfigurationAction("gemini", "gemini-3.6-flash");
    expect(result.ok).toBe(false);
    expect((result as { reason?: string }).reason).toBe("unavailable");
    expect(executeAITaskMock).not.toHaveBeenCalled();
  });

  it("rejects a non-allowlisted model without calling executeAITask", async () => {
    const result = await testAIConfigurationAction("gemini", "gemini-9000-ultra");
    expect(result.ok).toBe(false);
    expect(executeAITaskMock).not.toHaveBeenCalled();
  });

  it("tags the usage event as CONFIGURATION_TEST, distinct from operational tasks", async () => {
    await testAIConfigurationAction("gemini", "gemini-3.6-flash");
    expect(executeAITaskMock).toHaveBeenCalledWith(expect.objectContaining({ task: "CONFIGURATION_TEST", provider: "gemini", model: "gemini-3.6-flash" }));
  });
});
