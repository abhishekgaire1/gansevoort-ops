import crypto from "node:crypto";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { setupRpcTestFixtures, type RpcTestFixtures } from "./testFixtures";
import { createDraftPurchaseDocumentWithLines, getLineKeys, findOrCreateThrowawaySpendCategory, findOrCreateNamedEmployee } from "./itemMasterTestHelpers";
import { approveLineClassificationNewItemRpc } from "@/app/lib/itemMaster/approveLineClassificationNewItemRpc";
import { approveLineClassificationExistingItemRpc } from "@/app/lib/itemMaster/approveLineClassificationExistingItemRpc";
import { correctDocumentDeliveryVerifierRpc } from "@/app/lib/itemMaster/correctDocumentDeliveryVerifierRpc";
import { recordReceiptRpc } from "@/app/lib/receiving/recordReceiptRpc";
import { submitPurchaseDocumentForVerificationRpc } from "@/app/lib/purchaseDocuments/submitPurchaseDocumentForVerificationRpc";
import { verifyPurchaseDocumentRpc } from "@/app/lib/purchaseDocuments/verifyPurchaseDocumentRpc";
import { postPurchaseDocumentInventoryRpc } from "@/app/lib/inventory/postingRpcs";

/**
 * REAL two-connection concurrency proof for the price-series serialization
 * (20260811100167) and the posting guard. Uses two independent PostgreSQL
 * sessions with an explicit synchronization barrier -- NOT sequential
 * PostgREST calls.
 *
 * Requires a direct DEV Postgres connection string in SUPABASE_DB_URL (or
 * DATABASE_URL). It is NOT present in this repo's environment (only the
 * PostgREST API keys are), so this suite SKIPS with an explicit message
 * rather than fabricate a result. To run it, provide the DEV project's
 * Postgres connection string (session mode, e.g. the Supabase "Direct
 * connection" or session pooler URL WITH password) as SUPABASE_DB_URL.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL ?? null;
const describeIfDb = DB_URL ? describe : describe.skip;

if (!DB_URL) {
  // Surfaced once so the reason for the skip is unambiguous in CI logs.
  // eslint-disable-next-line no-console
  console.warn("[priceReviewConcurrency] SKIPPED -- set SUPABASE_DB_URL (DEV Postgres session connection string, with password) to run the real two-connection concurrency proof.");
}

let fx: RpcTestFixtures;
let locationId: string;

beforeAll(async () => {
  if (!DB_URL) return;
  fx = await setupRpcTestFixtures();
  const { data: loc } = await fx.supabase.from("locations").select("id").eq("organization_id", fx.organizationId).order("created_at", { ascending: true }).limit(1).single();
  locationId = loc!.id as string;
});

/** Build+verify a SAME_UNIT (LB) document at a chosen cost/date, either
 * creating a fresh item or reusing one (same price series). Sets invoice
 * facts on the DRAFT before submit. */
async function buildDoc(opts: { reuse?: { itemId: string; vendorSku: string }; unitCost: number; date: string }): Promise<{ purchaseDocumentId: string; lineKey: string; itemId: string; vendorSku: string }> {
  const spendCategoryId = await findOrCreateThrowawaySpendCategory(fx.supabase, fx.organizationId);
  const categoryId = (await fx.supabase.from("inventory_items").select("category_id").eq("id", fx.noRuleItemId).single()).data!.category_id as string;
  const deliveryVerifierEmployeeId = await findOrCreateNamedEmployee(fx.supabase, fx.organizationId, "TEST Delivery Verifier");
  const vendorSku = opts.reuse?.vendorSku ?? `PGC-${crypto.randomUUID().slice(0, 8)}`;
  const { purchaseDocumentId, documentId } = await createDraftPurchaseDocumentWithLines(fx.supabase, {
    organizationId: fx.organizationId, vendorId: fx.vendorId, uploadedByAppUserId: fx.changeableEmployeeAppUserId,
    lines: [{ vendorSku, description: "PriceGuard concurrency", packageUnit: "LB", packageQuantity: 10 }],
  });
  const [lineKey] = await getLineKeys(fx.supabase, purchaseDocumentId);
  let itemId: string;
  if (opts.reuse) {
    await approveLineClassificationExistingItemRpc(fx.supabase, { purchaseDocumentId, lineKey, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, inventoryItemId: opts.reuse.itemId, rememberVendorMapping: false });
    itemId = opts.reuse.itemId;
  } else {
    const approved = await approveLineClassificationNewItemRpc(fx.supabase, { purchaseDocumentId, lineKey, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, finalName: `PGC Item ${crypto.randomUUID().slice(0, 6)}`, disposition: "INVENTORY", categoryId, spendCategoryId, baseUnitCode: "LB", rememberVendorMapping: false });
    itemId = approved.inventoryItemId!;
  }
  await recordReceiptRpc(fx.supabase, {
    organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, receiptKind: "DELIVERY", purchaseDocumentId,
    lines: [{ lineNumberSnapshot: 1, matchedLineKey: lineKey, vendorSkuSnapshot: vendorSku, descriptionSnapshot: "PriceGuard concurrency", invoicePackageQuantity: 10, invoicePackageUnit: "LB", invoiceMeasuredQuantity: null, invoiceMeasuredUnit: null, actualReceivedPackageQuantity: 10, actualReceivedPackageUnit: "LB", actualVerifiedBaseQuantity: null, actualVerifiedBaseUnitId: null, locationId }],
  });
  await correctDocumentDeliveryVerifierRpc(fx.supabase, { documentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, newEmployeeId: deliveryVerifierEmployeeId });
  await fx.supabase.from("purchase_document_lines").update({ line_total: opts.unitCost * 10 }).eq("purchase_document_id", purchaseDocumentId).eq("line_key", lineKey);
  await fx.supabase.from("purchase_documents").update({ document_date: opts.date }).eq("id", purchaseDocumentId);
  const submitted = await submitPurchaseDocumentForVerificationRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId, expectedVersion: 1 });
  await verifyPurchaseDocumentRpc(fx.supabase, { purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.lockedEmployeeAppUserId, expectedVersion: submitted.version });
  return { purchaseDocumentId, lineKey, itemId, vendorSku };
}

async function ack(pd: string, lineKey: string, itemId: string, vendorSku: string, prevPd: string, prevCost: number, curCost: number) {
  return fx.supabase.rpc("acknowledge_price_change", {
    p_organization_id: fx.organizationId, p_actor_app_user_id: fx.changeableEmployeeAppUserId, p_purchase_document_id: pd, p_line_key: lineKey,
    p_inventory_item_id: itemId, p_vendor_id: fx.vendorId, p_vendor_sku: vendorSku, p_currency: "USD",
    p_previous_purchase_document_id: prevPd, p_previous_unit_cost: prevCost, p_current_unit_cost: curCost, p_delta_pct: ((curCost - prevCost) / prevCost) * 100,
    p_direction: curCost >= prevCost ? "increase" : "decrease", p_base_unit_code: "LB", p_normalized_base_quantity: 10, p_fingerprint: `fp-${crypto.randomUUID()}`, p_note: null,
  });
}

describeIfDb("price-review concurrency (two live Postgres connections)", () => {
  it("scenario A: same-series posts serialize -- the second blocks on the price-series lock, then re-selects the now-current baseline and rejects its stale acknowledgment (GA079)", async () => {
    // Prior posted baseline at $2.00/LB, then two same-series verified docs.
    const prior = await buildDoc({ unitCost: 2.0, date: "2026-01-01" });
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: prior.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    const docA = await buildDoc({ reuse: { itemId: prior.itemId, vendorSku: prior.vendorSku }, unitCost: 2.5, date: "2026-06-01" }); // +25%
    const docB = await buildDoc({ reuse: { itemId: prior.itemId, vendorSku: prior.vendorSku }, unitCost: 2.6, date: "2026-06-02" }); // vs $2.00 baseline
    await ack(docA.purchaseDocumentId, docA.lineKey, prior.itemId, prior.vendorSku, prior.purchaseDocumentId, 2.0, 2.5);
    await ack(docB.purchaseDocumentId, docB.lineKey, prior.itemId, prior.vendorSku, prior.purchaseDocumentId, 2.0, 2.6);

    const A = new Client({ connectionString: DB_URL! });
    const B = new Client({ connectionString: DB_URL! });
    await A.connect();
    await B.connect();
    try {
      // A begins posting and holds the transaction (series advisory lock held).
      await A.query("begin");
      await A.query("select public.post_purchase_document_inventory($1,$2,$3)", [docA.purchaseDocumentId, fx.organizationId, fx.changeableEmployeeAppUserId]);

      // B tries to post the same-series doc with a short statement timeout;
      // it must block on the series lock and time out (proof of serialization).
      await B.query("begin");
      await B.query("set local statement_timeout = '2000ms'");
      let bBlocked = false;
      try {
        await B.query("select public.post_purchase_document_inventory($1,$2,$3)", [docB.purchaseDocumentId, fx.organizationId, fx.changeableEmployeeAppUserId]);
      } catch (e) {
        bBlocked = /statement timeout|canceling statement/i.test(String((e as Error).message));
      }
      await B.query("rollback");
      expect(bBlocked).toBe(true);

      // A commits its post -> A's event becomes the newest in the series.
      await A.query("commit");

      // B retries without A holding the lock; it re-selects the now-current
      // baseline (A's $2.50 event), against which B's ack (for the $2.00
      // baseline) is stale -> GA079.
      await expect(
        postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: docB.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId })
      ).rejects.toThrow(/significant price change|GA079/i);

      // Each document posted at most once; B left no partial data.
      const { data: aHeaders } = await fx.supabase.from("purchase_document_inventory_postings").select("id").eq("purchase_document_id", docA.purchaseDocumentId);
      const { data: bHeaders } = await fx.supabase.from("purchase_document_inventory_postings").select("id").eq("purchase_document_id", docB.purchaseDocumentId);
      expect(aHeaders ?? []).toHaveLength(1);
      expect(bHeaders ?? []).toHaveLength(0);
    } finally {
      await A.end();
      await B.end();
    }
  });

  it("scenario B: while a posting transaction holds the input locks, a concurrent edit to the receipt line blocks (cannot slip between validation and posting)", async () => {
    const prior = await buildDoc({ unitCost: 2.0, date: "2026-01-01" });
    await postPurchaseDocumentInventoryRpc(fx.supabase, { purchaseDocumentId: prior.purchaseDocumentId, organizationId: fx.organizationId, appUserId: fx.changeableEmployeeAppUserId });
    const doc = await buildDoc({ reuse: { itemId: prior.itemId, vendorSku: prior.vendorSku }, unitCost: 2.5, date: "2026-06-01" });
    await ack(doc.purchaseDocumentId, doc.lineKey, prior.itemId, prior.vendorSku, prior.purchaseDocumentId, 2.0, 2.5);
    const { data: receipts } = await fx.supabase.rpc("effective_receipts_for_purchase_document", { p_purchase_document_id: doc.purchaseDocumentId, p_organization_id: fx.organizationId });
    const recIds = (receipts ?? []).map((r: { id: string }) => r.id);
    const { data: rls } = await fx.supabase.from("receipt_lines").select("id").in("receipt_id", recIds).eq("matched_line_key", doc.lineKey);
    const receiptLineId = rls![0].id as string;

    const A = new Client({ connectionString: DB_URL! });
    const B = new Client({ connectionString: DB_URL! });
    await A.connect();
    await B.connect();
    try {
      await A.query("begin");
      await A.query("select public.post_purchase_document_inventory($1,$2,$3)", [doc.purchaseDocumentId, fx.organizationId, fx.changeableEmployeeAppUserId]);
      await B.query("begin");
      await B.query("set local statement_timeout = '2000ms'");
      let editBlocked = false;
      try {
        await B.query("update public.receipt_lines set actual_received_package_quantity = 5 where id = $1", [receiptLineId]);
      } catch (e) {
        editBlocked = /statement timeout|canceling statement/i.test(String((e as Error).message));
      }
      await B.query("rollback");
      await A.query("commit");
      expect(editBlocked).toBe(true);
    } finally {
      await A.end();
      await B.end();
    }
  });
});
