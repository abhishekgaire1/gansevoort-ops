import { beforeAll, describe, expect, it } from "vitest";
import { tryClaimClassificationRunRpc, finishClassificationRunRpc } from "@/app/lib/itemMaster/classificationRunClaimRpc";
import { getClassificationRunStatus } from "@/app/lib/itemMaster/getClassificationRunStatus";
import { setupRpcTestFixtures, setupOtherOrgFixtures, type RpcTestFixtures, type OtherOrgFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines } from "./itemMasterTestHelpers";

/**
 * MANUAL / ON-DEMAND ONLY -- see purchaseDocuments.rpc.test.ts's header
 * comment for why these files aren't run in CI.
 *
 * Direct tests of try_claim_purchase_document_classification_run /
 * finish_purchase_document_classification_run against real Postgres --
 * exactly the class of behavior a mocked supabase.rpc() cannot prove: real
 * row-locking and the partial-unique-index backstop under genuine
 * concurrent access. Per the 2A.3 plan §9/§19, "or a second CLAIMED
 * immediately superseding" is explicitly NOT an acceptable outcome for any
 * of the concurrent scenarios below -- every race must resolve to strictly
 * exactly one CLAIMED and one ALREADY_RUNNING.
 */

let fx: RpcTestFixtures;
let otherOrg: OtherOrgFixtures;

beforeAll(async () => {
  fx = await setupRpcTestFixtures();
  otherOrg = await setupOtherOrgFixtures(fx.supabase);
});

async function newPurchaseDocumentId(): Promise<string> {
  const { purchaseDocumentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId,
    vendorId: fx.vendorId,
    uploadedByAppUserId: fx.changeableEmployeeAppUserId,
  });
  return purchaseDocumentId;
}

describe("try_claim_purchase_document_classification_run", () => {
  it("first caller acquires CLAIMED", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const result = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });
    expect(result.status).toBe("CLAIMED");
    expect(result.claimId).toBeTruthy();
  });

  it("a simultaneous second caller against the same fresh claim gets ALREADY_RUNNING, never steals it", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const [a, b] = await Promise.all([
      tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId }),
      tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["ALREADY_RUNNING", "CLAIMED"]);
  });

  it("finishing a claim then claiming again succeeds (CLAIMED again)", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const first = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });
    expect(first.status).toBe("CLAIMED");
    await finishClassificationRunRpc(fx.supabase, { claimId: first.claimId!, organizationId: fx.organizationId, outcome: "SUCCEEDED" });

    const second = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });
    expect(second.status).toBe("CLAIMED");
    expect(second.claimId).not.toBe(first.claimId);
  });

  it("a stale unfinished claim is atomically abandoned and replaced by a fresh CLAIMED", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const first = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });
    expect(first.status).toBe("CLAIMED");

    // Force it stale without waiting out a real threshold: back-date
    // started_at directly (test-only manipulation of otherwise-immutable
    // execution-coordination state -- this table is deliberately mutable,
    // see 20260811100039's own comment).
    await fx.supabase.from("purchase_document_classification_runs").update({ started_at: new Date(Date.now() - 10_000).toISOString() }).eq("id", first.claimId!);

    const second = await tryClaimClassificationRunRpc(fx.supabase, {
      purchaseDocumentId,
      organizationId: fx.organizationId,
      staleAfterSeconds: 5,
    });
    expect(second.status).toBe("CLAIMED");
    expect(second.claimId).not.toBe(first.claimId);

    const { data: abandoned } = await fx.supabase.from("purchase_document_classification_runs").select("outcome, completed_at").eq("id", first.claimId!).single();
    expect(abandoned!.outcome).toBe("ABANDONED");
    expect(abandoned!.completed_at).not.toBeNull();
  });

  it("two simultaneous callers on a document with no prior claim resolve to exactly one CLAIMED and one ALREADY_RUNNING", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const results = await Promise.all(
      Array.from({ length: 2 }, () => tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId }))
    );
    const claimed = results.filter((r) => r.status === "CLAIMED");
    const alreadyRunning = results.filter((r) => r.status === "ALREADY_RUNNING");
    expect(claimed).toHaveLength(1);
    expect(alreadyRunning).toHaveLength(1);
  });

  it("two simultaneous callers racing to reclaim the same stale claim resolve to exactly one CLAIMED and one ALREADY_RUNNING", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const first = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });
    await fx.supabase.from("purchase_document_classification_runs").update({ started_at: new Date(Date.now() - 10_000).toISOString() }).eq("id", first.claimId!);

    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, staleAfterSeconds: 5 })
      )
    );
    const claimed = results.filter((r) => r.status === "CLAIMED");
    const alreadyRunning = results.filter((r) => r.status === "ALREADY_RUNNING");
    expect(claimed).toHaveLength(1);
    expect(alreadyRunning).toHaveLength(1);

    const activeCount = await fx.supabase
      .from("purchase_document_classification_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", fx.organizationId)
      .eq("purchase_document_id", purchaseDocumentId)
      .is("completed_at", null);
    expect(activeCount.count).toBe(1);
  });

  it("org isolation: a claim in one org never blocks an identical purchase_document_id-shaped claim in another org", async () => {
    // Genuinely distinct purchase_document rows (the FK requires a real
    // row per org) -- the point is that two DIFFERENT orgs each claiming
    // their OWN document never observe or interfere with each other, which
    // the partial unique index's (organization_id, purchase_document_id)
    // key already guarantees structurally. This test proves it end-to-end.
    const purchaseDocumentIdOrgA = await newPurchaseDocumentId();
    const { purchaseDocumentId: purchaseDocumentIdOrgB } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
      organizationId: otherOrg.organizationId,
      vendorId: otherOrg.vendorId,
      uploadedByAppUserId: otherOrg.appUserId,
    });

    const claimA = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId: purchaseDocumentIdOrgA, organizationId: fx.organizationId });
    const claimB = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId: purchaseDocumentIdOrgB, organizationId: otherOrg.organizationId });

    expect(claimA.status).toBe("CLAIMED");
    expect(claimB.status).toBe("CLAIMED");
  });
});

describe("finish_purchase_document_classification_run", () => {
  it("is idempotent -- a second finish call against an already-completed claim is a silent no-op", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const claim = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });
    await finishClassificationRunRpc(fx.supabase, { claimId: claim.claimId!, organizationId: fx.organizationId, outcome: "SUCCEEDED" });
    await expect(
      finishClassificationRunRpc(fx.supabase, { claimId: claim.claimId!, organizationId: fx.organizationId, outcome: "FAILED" })
    ).resolves.toBeUndefined();

    const { data } = await fx.supabase.from("purchase_document_classification_runs").select("outcome").eq("id", claim.claimId!).single();
    // The FIRST finish call won -- the second's WHERE completed_at is null
    // guard made it a no-op, so outcome is still SUCCEEDED, never FAILED.
    expect(data!.outcome).toBe("SUCCEEDED");
  });
});

describe("getClassificationRunStatus", () => {
  it("reports inactive with no outcome when no run has ever been claimed", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const status = await getClassificationRunStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(status).toEqual({ active: false, outcome: null });
  });

  it("reports active while a claim is outstanding, then inactive with the real outcome once finished -- the exact signal Step 2's blocking 'Matching Items' state polls", async () => {
    const purchaseDocumentId = await newPurchaseDocumentId();
    const claim = await tryClaimClassificationRunRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId });

    const whileActive = await getClassificationRunStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(whileActive).toEqual({ active: true, outcome: null });

    await finishClassificationRunRpc(fx.supabase, { claimId: claim.claimId!, organizationId: fx.organizationId, outcome: "SUCCEEDED" });

    const afterFinish = await getClassificationRunStatus(fx.supabase, purchaseDocumentId, fx.organizationId);
    expect(afterFinish).toEqual({ active: false, outcome: "SUCCEEDED" });
  });
});
