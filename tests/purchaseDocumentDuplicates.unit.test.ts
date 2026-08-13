import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  findPossibleDuplicatePurchaseDocuments,
  isEligibleForDuplicateCheck,
} from "@/app/lib/purchaseDocuments/duplicateDetection";

// CI-safe: no network, no database. Proves the query is built correctly
// (organization/vendor/type/number filters, self-exclusion, and the
// "don't even query" skip conditions) -- cross-vendor/cross-type/cross-org
// non-collision is proven here by asserting those filters are actually
// present in the query the function builds, since a mocked client can't
// exercise real Postgres row filtering. End-to-end row-level proof (real
// distinct vendors/orgs/types genuinely not colliding) lives in the
// integration suite (purchaseDocuments.rpc.test.ts).

interface Call {
  method: string;
  args: unknown[];
}

function createChainable(result: { data: unknown; error: unknown }, calls: Call[]): unknown {
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

function fakeClient(rows: Record<string, unknown>[]): { client: SupabaseClient; calls: Call[]; from: ReturnType<typeof vi.fn> } {
  const calls: Call[] = [];
  const from = vi.fn(() => createChainable({ data: rows, error: null }, calls));
  return { client: { from } as unknown as SupabaseClient, calls, from };
}

const BASE_INPUT = {
  organizationId: "org-1",
  vendorId: "vendor-1",
  documentType: "INVOICE" as const,
  documentNumber: "839291",
};

describe("isEligibleForDuplicateCheck", () => {
  it("requires vendor, a real document type, and a non-blank number", () => {
    expect(isEligibleForDuplicateCheck(BASE_INPUT)).toBe(true);
    expect(isEligibleForDuplicateCheck({ ...BASE_INPUT, vendorId: null })).toBe(false);
    expect(isEligibleForDuplicateCheck({ ...BASE_INPUT, documentType: null })).toBe(false);
    expect(isEligibleForDuplicateCheck({ ...BASE_INPUT, documentNumber: null })).toBe(false);
    expect(isEligibleForDuplicateCheck({ ...BASE_INPUT, documentNumber: "   " })).toBe(false);
  });
});

describe("findPossibleDuplicatePurchaseDocuments -- query construction", () => {
  it("filters by organization_id, vendor_id, document_type, and document_number together", async () => {
    const { client, calls } = fakeClient([{ id: "pd-2", document_number: "839291", document_date: "2026-08-10", status: "VERIFIED" }]);

    const result = await findPossibleDuplicatePurchaseDocuments(client, BASE_INPUT);

    expect(calls).toContainEqual({ method: "eq", args: ["organization_id", "org-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["vendor_id", "vendor-1"] });
    expect(calls).toContainEqual({ method: "eq", args: ["document_type", "INVOICE"] });
    expect(calls).toContainEqual({ method: "eq", args: ["document_number", "839291"] });
    expect(result).toEqual([{ purchaseDocumentId: "pd-2", documentNumber: "839291", documentDate: "2026-08-10", status: "VERIFIED" }]);
  });

  it("excludes the current purchase document from its own results via neq(id, ...)", async () => {
    const { client, calls } = fakeClient([]);
    await findPossibleDuplicatePurchaseDocuments(client, { ...BASE_INPUT, excludePurchaseDocumentId: "pd-1" });
    expect(calls).toContainEqual({ method: "neq", args: ["id", "pd-1"] });
  });

  it("does not exclude anything when no excludePurchaseDocumentId is given (checking a not-yet-created draft)", async () => {
    const { client, calls } = fakeClient([]);
    await findPossibleDuplicatePurchaseDocuments(client, BASE_INPUT);
    expect(calls.some((c) => c.method === "neq")).toBe(false);
  });

  it("a different vendor is a separate filter value -- INVOICE #123 from Vendor A does not share a query with Vendor B", async () => {
    const { client, calls } = fakeClient([]);
    await findPossibleDuplicatePurchaseDocuments(client, { ...BASE_INPUT, vendorId: "vendor-B" });
    expect(calls).toContainEqual({ method: "eq", args: ["vendor_id", "vendor-B"] });
    expect(calls.some((c) => c.method === "eq" && c.args[0] === "vendor_id" && c.args[1] === "vendor-1")).toBe(false);
  });

  it("a different document type is a separate filter value -- INVOICE #123 does not share a query with RECEIPT #123", async () => {
    const { client, calls } = fakeClient([]);
    await findPossibleDuplicatePurchaseDocuments(client, { ...BASE_INPUT, documentType: "RECEIPT" });
    expect(calls).toContainEqual({ method: "eq", args: ["document_type", "RECEIPT"] });
    expect(calls.some((c) => c.method === "eq" && c.args[0] === "document_type" && c.args[1] === "INVOICE")).toBe(false);
  });

  it("skips the query entirely when vendorId is missing", async () => {
    const { client, from } = fakeClient([]);
    const result = await findPossibleDuplicatePurchaseDocuments(client, { ...BASE_INPUT, vendorId: null });
    expect(from).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("skips the query entirely when documentType is null or not a real type", async () => {
    const { client, from } = fakeClient([]);
    const result = await findPossibleDuplicatePurchaseDocuments(client, { ...BASE_INPUT, documentType: null });
    expect(from).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("skips the query entirely when documentNumber is null or blank", async () => {
    const { client: clientNull, from: fromNull } = fakeClient([]);
    await findPossibleDuplicatePurchaseDocuments(clientNull, { ...BASE_INPUT, documentNumber: null });
    expect(fromNull).not.toHaveBeenCalled();

    const { client: clientBlank, from: fromBlank } = fakeClient([]);
    await findPossibleDuplicatePurchaseDocuments(clientBlank, { ...BASE_INPUT, documentNumber: "   " });
    expect(fromBlank).not.toHaveBeenCalled();
  });

  it("represents matches at every lifecycle status (DRAFT / READY_FOR_VERIFICATION / VERIFIED) unchanged", async () => {
    const { client } = fakeClient([
      { id: "pd-draft", document_number: "839291", document_date: null, status: "DRAFT" },
      { id: "pd-ready", document_number: "839291", document_date: "2026-08-01", status: "READY_FOR_VERIFICATION" },
      { id: "pd-verified", document_number: "839291", document_date: "2026-07-15", status: "VERIFIED" },
    ]);

    const result = await findPossibleDuplicatePurchaseDocuments(client, BASE_INPUT);

    expect(result.map((r) => r.status)).toEqual(["DRAFT", "READY_FOR_VERIFICATION", "VERIFIED"]);
  });
});
