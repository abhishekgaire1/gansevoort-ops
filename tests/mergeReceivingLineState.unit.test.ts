import { describe, expect, it } from "vitest";
import { mergeReceivingLineState, type ReceivingLineDraft } from "@/app/lib/receiving/mergeReceivingLineState";
import type { ReceivingLineInfo } from "@/app/lib/receiving/getReceivingLines";

/**
 * The real Heavy Cream browser bug traced against live Gansevoort DEV data
 * turned out not to be a computeReceivingPrefill defect (it correctly
 * returns EMPTY for that exact line -- package_unit null, nothing
 * confirmed/remembered yet). The bug this file guards against is the
 * REACT-STATE side: ReceivingPanel's load() used to unconditionally
 * rebuild every line's draft state from scratch on every call (initial
 * mount, poll, refetch after submit, another manager's confirmation
 * landing), which both (a) could never let a safe prefill that only
 * becomes available on a LATER load reach a still-blank field usefully,
 * since nothing distinguished "still blank" from "manager typed, then
 * deleted", and (b) more importantly would silently discard any edit the
 * manager had already made (60 -> 58) the moment another load() fired.
 * mergeReceivingLineState is the pure fix: convenience prefill only ever
 * lands in a field that is CURRENTLY blank, never overwriting a
 * non-blank one, regardless of whether that non-blank value came from a
 * prior prefill or a manager's own typing.
 */

function line(overrides: Partial<ReceivingLineInfo>): ReceivingLineInfo {
  return {
    lineKey: "line-1",
    description: "Test Item",
    vendorSku: "SKU-1",
    invoicePackageQuantity: null,
    invoicePackageUnit: null,
    disposition: "INVENTORY",
    inventoryItemId: "item-1",
    baseUnitCode: null,
    baseUnitId: "unit-1",
    purchaseUnitCode: null,
    receivingBehavior: null,
    fixedConversionFactor: null,
    requiresVerifiedMeasurement: false,
    defaultReceivingLocationId: null,
    confirmedInvoiceUnitCode: null,
    ...overrides,
  };
}

const heavyCreamSafe = line({
  invoicePackageQuantity: 60,
  invoicePackageUnit: "CASE",
  baseUnitCode: "PIECE",
  purchaseUnitCode: "CASE",
  fixedConversionFactor: 12,
  receivingBehavior: "FIXED_CONVERSION",
});

const heavyCreamUnresolved = line({
  invoicePackageQuantity: 60,
  invoicePackageUnit: null, // the real Gansevoort DEV case -- nothing stated, nothing remembered
  baseUnitCode: "PIECE",
  purchaseUnitCode: "CASE",
  fixedConversionFactor: 12,
  receivingBehavior: "FIXED_CONVERSION",
});

describe("mergeReceivingLineState", () => {
  it("a safely resolved line starts its draft Received already filled -- Expected and Received are never allowed to disagree, because both come from the same computeReceivingPrefill call", () => {
    const [draft] = mergeReceivingLineState([heavyCreamSafe], [], []);
    expect(draft.receivedQuantity).toBe("60");
    expect(draft.receivedUnit).toBe("CASE");
  });

  it("an unsafe/unresolved quantity remains blank on first load -- never guesses CASE from packaging config", () => {
    const [draft] = mergeReceivingLineState([heavyCreamUnresolved], [], []);
    expect(draft.receivedQuantity).toBe("");
    expect(draft.receivedUnit).toBe("");
  });

  it("a safe prefill that only becomes available on a LATER load populates the still-pristine field, instead of being stuck blank forever", () => {
    const firstLoad = mergeReceivingLineState([heavyCreamUnresolved], [], []);
    expect(firstLoad[0].receivedQuantity).toBe("");

    // Between loads, a vendor invoice-unit confirmation lands (someone
    // else confirmed PIECE for this SKU) -- the SAME line now resolves.
    const nowResolved = line({ ...heavyCreamUnresolved, confirmedInvoiceUnitCode: "PIECE" });
    const secondLoad = mergeReceivingLineState([nowResolved], [], firstLoad);
    expect(secondLoad[0].receivedQuantity).toBe("60");
    expect(secondLoad[0].receivedUnit).toBe("PIECE");
  });

  it("a manager's edit (60 -> 58) survives a later refetch -- never silently reverted back to the invoiced quantity", () => {
    const firstLoad = mergeReceivingLineState([heavyCreamSafe], [], []);
    expect(firstLoad[0].receivedQuantity).toBe("60");

    const managerEdited: ReceivingLineDraft[] = [{ ...firstLoad[0], receivedQuantity: "58" }];
    const refetch = mergeReceivingLineState([heavyCreamSafe], [], managerEdited);
    expect(refetch[0].receivedQuantity).toBe("58");
    expect(refetch[0].receivedUnit).toBe("CASE"); // untouched field, still whatever it already was
  });

  it("a remembered item location fills an untouched (blank) location field", () => {
    const withDefault = line({ ...heavyCreamSafe, defaultReceivingLocationId: "loc-central-walkin" });
    const [draft] = mergeReceivingLineState([withDefault], [], []);
    expect(draft.locationId).toBe("loc-central-walkin");
  });

  it("a manager-selected location is not overwritten by a later refresh, even if the item's remembered default is different or changes", () => {
    const firstLoad = mergeReceivingLineState([line({ ...heavyCreamSafe, defaultReceivingLocationId: "loc-central-walkin" })], [], []);
    const managerPicked: ReceivingLineDraft[] = [{ ...firstLoad[0], locationId: "loc-dry-storage-c2" }];

    // A later refetch, even with a DIFFERENT remembered default, must not
    // override the manager's own explicit choice.
    const refetch = mergeReceivingLineState([line({ ...heavyCreamSafe, defaultReceivingLocationId: "loc-freezer" })], [], managerPicked);
    expect(refetch[0].locationId).toBe("loc-dry-storage-c2");
  });

  it("a variable-weight item's package quantity prefills while Verified Weight remains blank, and stays blank across refetches", () => {
    const koreanRadish = line({
      invoicePackageQuantity: 1,
      invoicePackageUnit: "BOX",
      baseUnitCode: "LB",
      purchaseUnitCode: "BOX",
      receivingBehavior: "MEASURE_EACH_DELIVERY",
      requiresVerifiedMeasurement: true,
    });
    const firstLoad = mergeReceivingLineState([koreanRadish], [], []);
    expect(firstLoad[0]).toMatchObject({ receivedQuantity: "1", receivedUnit: "BOX", verifiedQuantity: "" });

    const refetch = mergeReceivingLineState([koreanRadish], [], firstLoad);
    expect(refetch[0].verifiedQuantity).toBe("");

    // The manager enters the actual verified weight -- a further refetch
    // must not wipe it back to blank.
    const withVerified: ReceivingLineDraft[] = [{ ...firstLoad[0], verifiedQuantity: "22.4" }];
    const afterVerifiedEntered = mergeReceivingLineState([koreanRadish], [], withVerified);
    expect(afterVerifiedEntered[0].verifiedQuantity).toBe("22.4");
  });

  it("the sole org location fills an untouched location the same way on every load, without ever overwriting a manager's own choice", () => {
    const firstLoad = mergeReceivingLineState([heavyCreamSafe], [{ id: "loc-only" }], []);
    expect(firstLoad[0].locationId).toBe("loc-only");

    const managerCleared: ReceivingLineDraft[] = [{ ...firstLoad[0], locationId: "" }];
    const refetch = mergeReceivingLineState([heavyCreamSafe], [{ id: "loc-only" }], managerCleared);
    expect(refetch[0].locationId).toBe("loc-only"); // blank is pristine -- safe to refill
  });

  it("a genuinely NEW line appearing on a later load is built fresh, without disturbing already-merged lines", () => {
    const firstLoad = mergeReceivingLineState([heavyCreamSafe], [], []);
    const managerEdited: ReceivingLineDraft[] = [{ ...firstLoad[0], receivedQuantity: "58" }];

    const newLine = line({ lineKey: "line-2", invoicePackageQuantity: 4, invoicePackageUnit: "LB", baseUnitCode: "LB", receivingBehavior: "SAME_UNIT" });
    const secondLoad = mergeReceivingLineState([heavyCreamSafe, newLine], [], managerEdited);

    expect(secondLoad.find((l) => l.lineKey === "line-1")?.receivedQuantity).toBe("58"); // untouched
    expect(secondLoad.find((l) => l.lineKey === "line-2")?.receivedQuantity).toBe("4"); // fresh prefill
  });

  it("non-INVENTORY lines never participate", () => {
    const result = mergeReceivingLineState([line({ disposition: "NON_INVENTORY", invoicePackageQuantity: 1 })], [], []);
    expect(result).toHaveLength(0);
  });

  it("invoiceUnitConflict is refreshed from the latest prefill on every merge -- purely informational, never a manager-editable field to preserve", () => {
    const conflicting = line({
      invoicePackageQuantity: 5,
      invoicePackageUnit: "CASE",
      baseUnitCode: "PIECE",
      purchaseUnitCode: "CASE",
      fixedConversionFactor: 12,
      receivingBehavior: "FIXED_CONVERSION",
      confirmedInvoiceUnitCode: "PIECE",
    });
    const firstLoad = mergeReceivingLineState([conflicting], [], []);
    expect(firstLoad[0].invoiceUnitConflict).toEqual({ invoiceUnit: "CASE", rememberedUnit: "PIECE" });

    const resolvedNow = line({ ...conflicting, confirmedInvoiceUnitCode: "CASE" }); // manager resolved it elsewhere; memory now agrees
    const refetch = mergeReceivingLineState([resolvedNow], [], firstLoad);
    expect(refetch[0].invoiceUnitConflict).toBeNull();
  });
});
