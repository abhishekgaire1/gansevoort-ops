import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database. Focused on the RC1 error-handling fix
// -- an unexpected/unrecognized error thrown by the RPC layer must never
// reach the client as raw text, while every EXISTING recognized-error
// mapping and the successful-completion shape must stay exactly as they
// were before the fix.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

const { startOrResumeCycleCountMock, completeCycleCountMock } = vi.hoisted(() => ({
  startOrResumeCycleCountMock: vi.fn(),
  completeCycleCountMock: vi.fn(),
}));
vi.mock("@/app/lib/inventory/cycleCounts", () => ({
  startOrResumeCycleCount: startOrResumeCycleCountMock,
  completeCycleCount: completeCycleCountMock,
}));

import { startOrResumeCycleCountAction, completeCycleCountAction } from "@/app/actions/cycleCounts";
import {
  InvalidStorageLocationError,
  CycleCountOwnedByAnotherManagerError,
  StaleCycleCountError,
  CycleCountLockedError,
  MissingCompletionNoteError,
  CycleCountKnownWasteUnresolvedError,
} from "@/app/lib/inventory/errors";

const MANAGER_AUTH = { ok: true as const, manager: { appUserId: "app-user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] } };
const SENSITIVE_TEXT = "postgres internal relation inventory_secret_table";

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER_AUTH);
  getServiceRoleClientMock.mockReset().mockReturnValue({});
  startOrResumeCycleCountMock.mockReset();
  completeCycleCountMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("completeCycleCountAction -- unexpected-error handling", () => {
  it("1. an unexpected Error with sensitive-looking internal text is never returned to the client", async () => {
    completeCycleCountMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(SENSITIVE_TEXT);
      expect(result.message).not.toContain("inventory_secret_table");
    }
  });

  it("2. a non-Error thrown value is not stringified and returned to the client", async () => {
    completeCycleCountMock.mockRejectedValue({ weird: "raw object", detail: SENSITIVE_TEXT });
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(SENSITIVE_TEXT);
      expect(result.message).not.toContain("[object Object]");
    }
  });

  it("3. the generic safe message is returned for an unexpected failure", async () => {
    completeCycleCountMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Something went wrong. Try again." });
  });

  it("4. the internal unexpected error is logged server-side", async () => {
    const err = new Error(SENSITIVE_TEXT);
    completeCycleCountMock.mockRejectedValue(err);
    await completeCycleCountAction("cc-1", 1, "note");
    expect(console.error).toHaveBeenCalledWith(
      "completeCycleCountAction: unexpected error",
      expect.objectContaining({ cycleCountId: "cc-1", expectedVersion: 1, error: expect.objectContaining({ message: SENSITIVE_TEXT }) })
    );
  });

  it("5a. existing recognized error mapping (StaleCycleCountError) is unchanged", async () => {
    const staleErr = new StaleCycleCountError("stale", JSON.stringify([]));
    completeCycleCountMock.mockRejectedValue(staleErr);
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "stale") {
      expect(result.message).toBe("Inventory changed while you were counting. Recount the items below and try again.");
    } else {
      throw new Error("expected reason 'stale'");
    }
    expect(console.error).not.toHaveBeenCalled(); // a recognized error is not logged as unexpected
  });

  it("5b. existing recognized error mapping (CycleCountOwnedByAnotherManagerError) is unchanged", async () => {
    completeCycleCountMock.mockRejectedValue(new CycleCountOwnedByAnotherManagerError("owned"));
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result).toEqual({
      ok: false,
      reason: "owned_by_another_manager",
      message: "This cycle count was started by another manager and can only be resumed by them.",
    });
  });

  it("5c. existing recognized error mapping (MissingCompletionNoteError) is unchanged", async () => {
    completeCycleCountMock.mockRejectedValue(new MissingCompletionNoteError("missing note"));
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result).toEqual({ ok: false, reason: "missing_note", message: "A completion note is required to complete a cycle count." });
  });

  it("5d. existing recognized error mapping (CycleCountLockedError) is unchanged", async () => {
    completeCycleCountMock.mockRejectedValue(new CycleCountLockedError("locked"));
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result).toEqual({
      ok: false,
      reason: "locked",
      message: "This cycle count was already completed, cancelled, or changed. Reload and try again.",
    });
  });

  it("5e. existing recognized error mapping (CycleCountKnownWasteUnresolvedError) is unchanged", async () => {
    completeCycleCountMock.mockRejectedValue(new CycleCountKnownWasteUnresolvedError("unresolved"));
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result).toEqual({
      ok: false,
      reason: "known_waste_unresolved",
      message: "Known waste must be recorded before this cycle count can be completed.",
    });
  });

  it("6. successful completion behavior is unchanged", async () => {
    const rpcResult = { cycleCountId: "cc-1", status: "COMPLETED" as const, version: 2 };
    completeCycleCountMock.mockResolvedValue(rpcResult);
    const result = await completeCycleCountAction("cc-1", 1, "note");
    expect(result).toEqual({ ok: true, result: rpcResult });
  });

  it("7. RPC parameters and authorization are unchanged", async () => {
    completeCycleCountMock.mockResolvedValue({ cycleCountId: "cc-1", status: "COMPLETED", version: 2 });
    await completeCycleCountAction("cc-1", 5, "a note");
    expect(requireManagerOrAdminMock).toHaveBeenCalledTimes(1);
    expect(completeCycleCountMock).toHaveBeenCalledWith(expect.anything(), {
      cycleCountId: "cc-1",
      expectedVersion: 5,
      completedByAppUserId: "app-user-1",
      completionNote: "a note",
    });
  });
});

describe("startOrResumeCycleCountAction -- the same fix applied to a second action", () => {
  it("unexpected error returns the generic message, not raw text, and is logged", async () => {
    startOrResumeCycleCountMock.mockRejectedValue(new Error(SENSITIVE_TEXT));
    const result = await startOrResumeCycleCountAction("loc-1");
    expect(result).toEqual({ ok: false, reason: "misconfigured", message: "Something went wrong. Try again." });
    expect(console.error).toHaveBeenCalledWith("startOrResumeCycleCountAction: unexpected error", expect.objectContaining({ locationId: "loc-1" }));
  });

  it("recognized InvalidStorageLocationError mapping is unchanged", async () => {
    startOrResumeCycleCountMock.mockRejectedValue(new InvalidStorageLocationError("bad location"));
    const result = await startOrResumeCycleCountAction("loc-1");
    expect(result).toEqual({ ok: false, reason: "invalid_location", message: "That location is not an active storage location." });
  });

  it("successful start/resume behavior is unchanged", async () => {
    const rpcResult = { cycleCountId: "cc-2", status: "DRAFT" as const, created: true };
    startOrResumeCycleCountMock.mockResolvedValue(rpcResult);
    const result = await startOrResumeCycleCountAction("loc-1");
    expect(result).toEqual({ ok: true, result: rpcResult });
  });
});
