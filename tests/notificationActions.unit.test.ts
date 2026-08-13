import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CI-safe: no network, no database.

const { requireManagerOrAdminMock } = vi.hoisted(() => ({ requireManagerOrAdminMock: vi.fn() }));
vi.mock("@/app/lib/auth/managerAuth", () => ({ requireManagerOrAdmin: requireManagerOrAdminMock }));

const { getServiceRoleClientMock } = vi.hoisted(() => ({ getServiceRoleClientMock: vi.fn() }));
vi.mock("@/app/lib/supabase/serviceClient", () => ({ getServiceRoleClient: getServiceRoleClientMock }));

import { listNotifications, markNotificationRead, markAllNotificationsRead } from "@/app/actions/notifications";

const MANAGER = {
  ok: true as const,
  manager: { appUserId: "user-1", organizationId: "org-1", authUserId: "auth-1", roles: ["manager"] },
};

interface Call {
  method: string;
  args: unknown[];
}

function createChainable(result: { data: unknown; error: unknown; count?: number }, calls: Call[]): unknown {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void, reject?: (reason: unknown) => void) => Promise.resolve(result).then(resolve, reject);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return proxy;
      };
    },
  };
  const proxy: unknown = new Proxy(() => {}, handler);
  return proxy;
}

function fakeClient(opts: { rows?: Record<string, unknown>[]; unreadCount?: number }) {
  const listCalls: Call[] = [];
  const countCalls: Call[] = [];
  const updateCalls: Call[] = [];
  let call = 0;
  const from = vi.fn(() => {
    call += 1;
    // listNotifications issues a select-list call then a count call (via
    // Promise.all); mark/markAll issue update calls only.
    if (call === 1) return createChainable({ data: opts.rows ?? [], error: null }, listCalls);
    if (call === 2) return createChainable({ data: null, error: null, count: opts.unreadCount ?? 0 }, countCalls);
    return createChainable({ data: null, error: null }, updateCalls);
  });
  return { client: { from }, from, listCalls, countCalls, updateCalls };
}

beforeEach(() => {
  requireManagerOrAdminMock.mockReset().mockResolvedValue(MANAGER);
  getServiceRoleClientMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listNotifications", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await listNotifications();
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(getServiceRoleClientMock).not.toHaveBeenCalled();
  });

  it("scopes both the list and unread-count queries to the caller's own organization and recipient id", async () => {
    const { client, from, listCalls, countCalls } = fakeClient({
      rows: [
        {
          id: "notif-1",
          type: "PURCHASE_DOCUMENT_VERIFIED_WITH_CORRECTIONS",
          entity_type: "purchase_document",
          entity_id: "pd-1",
          title: "Verified with corrections",
          body: null,
          metadata: { finalCorrectionCount: 2 },
          read_at: null,
          created_at: "2026-08-12T00:00:00Z",
        },
      ],
      unreadCount: 3,
    });
    getServiceRoleClientMock.mockReturnValue(client);

    const result = await listNotifications();

    expect(from).toHaveBeenCalledWith("user_notifications");
    expect(listCalls).toContainEqual({ method: "eq", args: ["organization_id", "org-1"] });
    expect(listCalls).toContainEqual({ method: "eq", args: ["recipient_app_user_id", "user-1"] });
    expect(countCalls).toContainEqual({ method: "eq", args: ["organization_id", "org-1"] });
    expect(countCalls).toContainEqual({ method: "eq", args: ["recipient_app_user_id", "user-1"] });

    expect(result).toEqual({
      ok: true,
      unreadCount: 3,
      notifications: [
        {
          id: "notif-1",
          type: "PURCHASE_DOCUMENT_VERIFIED_WITH_CORRECTIONS",
          entityType: "purchase_document",
          entityId: "pd-1",
          title: "Verified with corrections",
          body: null,
          metadata: { finalCorrectionCount: 2 },
          readAt: null,
          createdAt: "2026-08-12T00:00:00Z",
        },
      ],
    });
  });
});

describe("markNotificationRead", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    requireManagerOrAdminMock.mockResolvedValue({ ok: false, reason: "not_authenticated" });
    const result = await markNotificationRead("notif-1");
    expect(result).toEqual({ ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." });
    expect(getServiceRoleClientMock).not.toHaveBeenCalled();
  });

  it("scopes the update to the caller's own organization, recipient id, and the given notification id", async () => {
    const calls: Call[] = [];
    const from = vi.fn(() => createChainable({ data: null, error: null }, calls));
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await markNotificationRead("notif-1");

    expect(calls).toContainEqual({ method: "eq", args: ["id", "notif-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["organization_id", "org-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["recipient_app_user_id", "user-1"] });
    expect(result).toEqual({ ok: true });
  });
});

describe("markAllNotificationsRead", () => {
  it("scopes the bulk update to the caller's own organization and recipient id (never another manager's notifications)", async () => {
    const calls: Call[] = [];
    const from = vi.fn(() => createChainable({ data: null, error: null }, calls));
    getServiceRoleClientMock.mockReturnValue({ from });

    const result = await markAllNotificationsRead();

    expect(calls).toContainEqual({ method: "eq", args: ["organization_id", "org-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["recipient_app_user_id", "user-1"] });
    expect(calls.some((c) => c.method === "eq" && c.args[0] === "id")).toBe(false);
    expect(result).toEqual({ ok: true });
  });
});
