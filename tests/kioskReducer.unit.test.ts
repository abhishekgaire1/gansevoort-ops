import { describe, expect, it } from "vitest";
import { createInitialKioskState, kioskReducer, type KioskState, type CartLine } from "@/app/kiosk/_lib/kioskReducer";
import type { KioskUsageUnits } from "@/app/actions/withdrawalUnit";

// CI-safe: pure reducer logic, no network, no database.

const STATION_CONFIG = {
  defaultStationId: "station-1",
  defaultStationName: "Grill",
  autoResolveStation: true,
  canChangeStation: false,
};

// A one-unit item's usage units (primary only, no selector needed) --
// stands in for the loader's result under the purchase-versus-usage unit
// model (20260811100119/100120).
const USAGE_UNITS: KioskUsageUnits = {
  primary: { usageUnitId: "usage-1", unitId: "unit-lb", unitCode: "LB", unitName: "Pound", slot: 1 },
  secondary: null,
  needsSelector: false,
};

// A two-unit item's usage units -- primary + secondary, selector required.
const USAGE_UNITS_WITH_SECONDARY: KioskUsageUnits = {
  primary: { usageUnitId: "usage-1", unitId: "unit-lb", unitCode: "LB", unitName: "Pound", slot: 1 },
  secondary: { usageUnitId: "usage-2", unitId: "unit-case", unitCode: "CASE", unitName: "Case", slot: 2 },
  needsSelector: true,
};

function makeCartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    id: "item-1::loc-a",
    inventoryItemId: "item-1",
    itemName: "Chicken Thigh",
    categoryName: "Meat",
    sourceLocationId: "loc-a",
    sourceLocationName: "Central Walk-In",
    enteredQuantity: "5",
    enteredUnitId: "unit-lb",
    unitCode: "LB",
    ...overrides,
  };
}

function pinVerifiedState(overrides: Partial<KioskState> = {}): KioskState {
  const state = kioskReducer(createInitialKioskState(), {
    type: "PIN_VERIFIED",
    kioskToken: "token-1",
    employeeDisplayName: "Maria G.",
    employeeFirstName: "Maria",
    stationConfig: STATION_CONFIG,
    nextStep: "station_resolving",
    autoSelectedStationId: "station-1",
    autoSelectedStationName: "Grill",
  });
  return { ...state, ...overrides };
}

describe("kioskReducer", () => {
  it("PIN_VERIFIED populates identity/session/station fields from a clean slate", () => {
    const state = pinVerifiedState();
    expect(state.step).toBe("station_resolving");
    expect(state.kioskToken).toBe("token-1");
    expect(state.employeeDisplayName).toBe("Maria G.");
    expect(state.selectedStationId).toBe("station-1");
    expect(state.tokenClientIssuedAt).not.toBeNull();
    expect(state.sessionStartedAtClient).not.toBeNull();
  });

  it("USAGE_UNITS_LOADED populates the item's usage units, defaults selection to primary, and resets enteredQuantity", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
    expect(state.usageUnits).toEqual(USAGE_UNITS);
    expect(state.selectedUsageUnitId).toBe("unit-lb");
    expect(state.enteredQuantity).toBe("");
  });

  it("USAGE_UNITS_LOADED with a two-unit item still defaults selection to primary", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS_WITH_SECONDARY });
    expect(state.usageUnits?.needsSelector).toBe(true);
    expect(state.selectedUsageUnitId).toBe("unit-lb");
  });

  it("USAGE_UNIT_SELECTED switches the selection to the secondary unit and resets enteredQuantity (never silently reuses an incompatible quantity)", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS_WITH_SECONDARY });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "5" });

    state = kioskReducer(state, { type: "USAGE_UNIT_SELECTED", unitId: "unit-case" });
    expect(state.selectedUsageUnitId).toBe("unit-case");
    expect(state.enteredQuantity).toBe("");
  });

  it("USAGE_UNIT_SELECTED is a no-op (keeps the entered quantity) when reselecting the already-active unit", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS_WITH_SECONDARY });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "5" });

    state = kioskReducer(state, { type: "USAGE_UNIT_SELECTED", unitId: "unit-lb" });
    expect(state.selectedUsageUnitId).toBe("unit-lb");
    expect(state.enteredQuantity).toBe("5");
  });

  it("WITHDRAWAL_UNIT_UNAVAILABLE stays on quantity_entry with a compact inline flag -- it does not bounce back to item_select or set the disruptive errorBanner", () => {
    // Covers "improperly configured items cannot cause the current
    // disruptive selection flow": the old behavior dispatched
    // BACK_TO_ITEMS with an errorBanner message, which rendered a large
    // ErrorState banner on a different screen. The employee should stay
    // right where they are, with just the compact flag set.
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "WITHDRAWAL_UNIT_UNAVAILABLE" });

    expect(state.step).toBe("quantity_entry");
    expect(state.withdrawalUnitUnavailable).toBe(true);
    expect(state.usageUnits).toBeNull();
    expect(state.errorBanner).toBeNull();
    expect(state.selectedItem).toEqual({ id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null });
  });

  it("ITEM_SELECTED and BACK_TO_ITEMS clear withdrawalUnitUnavailable, so a fresh item selection re-attempts the fetch", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "WITHDRAWAL_UNIT_UNAVAILABLE" });
    expect(state.withdrawalUnitUnavailable).toBe(true);

    const backToItems = kioskReducer(state, { type: "BACK_TO_ITEMS" });
    expect(backToItems.withdrawalUnitUnavailable).toBe(false);

    const reselected = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-2", name: "Eggs", categoryId: "cat-2", categoryName: "Dairy", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    expect(reselected.withdrawalUnitUnavailable).toBe(false);
  });

  it("QUANTITY_CHANGED updates only enteredQuantity -- no other field is perturbed by typing", () => {
    // The state-level analog of "values change, controls don't move": there
    // is no layout/UI-shape field anywhere in KioskState for typing a digit
    // to touch, so this asserts every other field is referentially/value
    // identical before and after.
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
    const before = state;
    const after = kioskReducer(before, { type: "QUANTITY_CHANGED", value: "43.6" });

    expect(after.enteredQuantity).toBe("43.6");
    // Every other field must be untouched: overwriting enteredQuantity back
    // to its pre-change value should make `after` deep-equal `before`.
    expect({ ...after, enteredQuantity: before.enteredQuantity }).toEqual(before);
  });

  it("ITEM_SELECTED clears any previously loaded usage units/quantity for the prior item", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "2" });

    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-2", name: "Eggs", categoryId: "cat-2", categoryName: "Dairy", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
    });
    expect(state.usageUnits).toBeNull();
    expect(state.selectedUsageUnitId).toBeNull();
    expect(state.enteredQuantity).toBe("");
    expect(state.step).toBe("quantity_entry");
  });

  it("SUBMIT_ATTEMPT_STARTED generates a clientRequestId only once; a retry after SUBMIT_FAILED reuses the same id", () => {
    let state = pinVerifiedState({ step: "review" });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    expect(state.clientRequestId).toBe("req-1");
    expect(state.submitting).toBe(true);

    state = kioskReducer(state, { type: "SUBMIT_FAILED", message: "network error" });
    expect(state.submitting).toBe(false);
    expect(state.clientRequestId).toBe("req-1"); // preserved for retry

    // A retry dispatches SUBMIT_ATTEMPT_STARTED again with a freshly
    // generated id, but the reducer must keep the ORIGINAL id, not adopt
    // the new one -- that's what makes the retry idempotent.
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-2-should-be-ignored" });
    expect(state.clientRequestId).toBe("req-1");
  });

  it("BATCH_SUBMIT_SUCCESS clears the cart and in-progress selection but PRESERVES employee/station identity (2A.5 Part 21 -- Withdraw More stays authenticated)", () => {
    let state = pinVerifiedState({ step: "review", cart: [makeCartLine({ id: "item-1::loc-a" })] });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    state = kioskReducer(state, { type: "BATCH_SUBMIT_SUCCESS", itemCount: 1 });

    expect(state.step).toBe("success");
    expect(state.submitting).toBe(false);
    expect(state.clientRequestId).toBeNull();
    expect(state.cart).toEqual([]);
    expect(state.successSummary).toEqual({ itemCount: 1, stationName: state.selectedStationName });
    // Identity/session survive -- this is the whole point of Withdraw More.
    expect(state.kioskToken).toBe("token-1");
    expect(state.employeeDisplayName).toBe("Maria G.");
    expect(state.employeeFirstName).toBe("Maria");
    expect(state.selectedStationId).not.toBeNull();
    expect(state.selectedStationName).not.toBeNull();
  });

  it("START_OVER fully resets every field back to the initial state shape, including a non-empty cart", () => {
    let state = pinVerifiedState({ step: "review", cart: [makeCartLine()] });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    state = kioskReducer(state, { type: "START_OVER" });

    const fresh = createInitialKioskState();
    expect(state.step).toBe(fresh.step);
    expect(state.kioskToken).toBeNull();
    expect(state.employeeDisplayName).toBeNull();
    expect(state.employeeFirstName).toBeNull();
    expect(state.stationConfig).toBeNull();
    expect(state.selectedStationId).toBeNull();
    expect(state.selectedStationName).toBeNull();
    expect(state.selectedItem).toBeNull();
    expect(state.usageUnits).toBeNull();
    expect(state.selectedUsageUnitId).toBeNull();
    expect(state.clientRequestId).toBeNull();
    expect(state.errorBanner).toBeNull();
    expect(state.cart).toEqual([]);
  });

  it("SESSION_EXPIRED fully resets state (identity must disappear, not just the visible screen) and sets a banner", () => {
    let state = pinVerifiedState({ step: "quantity_entry" });
    state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "5" });
    state = kioskReducer(state, { type: "SESSION_EXPIRED" });

    expect(state.step).toBe("pin");
    expect(state.kioskToken).toBeNull();
    expect(state.employeeDisplayName).toBeNull();
    expect(state.employeeFirstName).toBeNull();
    expect(state.selectedStationName).toBeNull();
    expect(state.usageUnits).toBeNull();
    expect(state.enteredQuantity).toBe("");
    expect(state.errorBanner?.message).toMatch(/session expired/i);
  });

  it("RATE_LIMITED and PIN_FAILED reset to a clean pin-step state with a banner, without touching any prior session", () => {
    const rateLimited = kioskReducer(createInitialKioskState(), { type: "RATE_LIMITED" });
    expect(rateLimited.step).toBe("pin");
    expect(rateLimited.errorBanner).not.toBeNull();

    const pinFailed = kioskReducer(createInitialKioskState(), { type: "PIN_FAILED", message: "Incorrect PIN. Try again." });
    expect(pinFailed.step).toBe("pin");
    expect(pinFailed.errorBanner?.message).toBe("Incorrect PIN. Try again.");
  });

  // Milestone 2A.5: source-location selection never guesses -- it's
  // auto-set only when there is exactly one candidate, and cleared
  // whenever a new item is chosen.
  describe("AVAILABILITY_LOADED / SOURCE_LOCATION_SELECTED (2A.5)", () => {
    it("auto-selects the source location when exactly one location has stock", () => {
      let state = pinVerifiedState();
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null } });
      state = kioskReducer(state, {
        type: "AVAILABILITY_LOADED",
        locations: [{ locationId: "loc-a", locationName: "Central Walk-In", baseUnitCode: "LB", balance: 56, fullReferenceQuantity: 72, includesLegacyEstimate: false }],
      });
      expect(state.selectedSourceLocationId).toBe("loc-a");
      expect(state.availableLocations).toHaveLength(1);
    });

    it("does NOT auto-select when multiple locations have stock -- requires an explicit employee choice", () => {
      let state = pinVerifiedState();
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null } });
      state = kioskReducer(state, {
        type: "AVAILABILITY_LOADED",
        locations: [
          { locationId: "loc-a", locationName: "Central Walk-In", baseUnitCode: "LB", balance: 24, fullReferenceQuantity: 36, includesLegacyEstimate: false },
          { locationId: "loc-b", locationName: "Dry Storage C2", baseUnitCode: "LB", balance: 16, fullReferenceQuantity: 20, includesLegacyEstimate: true },
        ],
      });
      expect(state.selectedSourceLocationId).toBeNull();

      const chosen = kioskReducer(state, { type: "SOURCE_LOCATION_SELECTED", locationId: "loc-b" });
      expect(chosen.selectedSourceLocationId).toBe("loc-b");
      expect(chosen.enteredQuantity).toBe(""); // switching locations clears any partially-typed quantity
    });

    it("an empty locations array (genuinely out of stock) selects nothing -- never a fake fallback", () => {
      let state = pinVerifiedState();
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null } });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [] });
      expect(state.availableLocations).toEqual([]);
      expect(state.selectedSourceLocationId).toBeNull();
    });

    it("ITEM_SELECTED clears any previously loaded availability/source-location choice from the prior item", () => {
      let state = pinVerifiedState();
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null } });
      state = kioskReducer(state, {
        type: "AVAILABILITY_LOADED",
        locations: [{ locationId: "loc-a", locationName: "Central Walk-In", baseUnitCode: "LB", balance: 56, fullReferenceQuantity: 72, includesLegacyEstimate: false }],
      });
      expect(state.selectedSourceLocationId).toBe("loc-a");

      const reselected = kioskReducer(state, { type: "ITEM_SELECTED", item: { id: "item-2", name: "Sour Cream", categoryId: "cat-1", categoryName: "Dairy", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null } });
      expect(reselected.availableLocations).toBeNull();
      expect(reselected.selectedSourceLocationId).toBeNull();
    });

    it("BACK_TO_ITEMS clears availability/source-location state", () => {
      let state = pinVerifiedState();
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null } });
      state = kioskReducer(state, {
        type: "AVAILABILITY_LOADED",
        locations: [{ locationId: "loc-a", locationName: "Central Walk-In", baseUnitCode: "LB", balance: 56, fullReferenceQuantity: 72, includesLegacyEstimate: false }],
      });
      state = kioskReducer(state, { type: "BACK_TO_ITEMS" });
      expect(state.availableLocations).toBeNull();
      expect(state.selectedSourceLocationId).toBeNull();
    });
  });

  // Milestone 2A.5: Change Station is now reachable from any authenticated
  // screen, not only immediately post-login -- so it must never carry an
  // in-progress withdrawal (item/quantity/source/idempotency key) from the
  // old station into the new one.
  describe("REQUEST_CHANGE_STATION (2A.5 -- reachable mid-withdrawal)", () => {
    function stateWithInProgressWithdrawal() {
      let state = pinVerifiedState();
      state = kioskReducer(state, {
        type: "ITEM_SELECTED",
        item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null },
      });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
      state = kioskReducer(state, {
        type: "AVAILABILITY_LOADED",
        locations: [{ locationId: "loc-a", locationName: "Central Walk-In", baseUnitCode: "LB", balance: 56, fullReferenceQuantity: 72, includesLegacyEstimate: false }],
      });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "4" });
      state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-in-flight" });
      state = { ...state, cart: [makeCartLine({ id: "item-2::loc-b" })] };
      return state;
    }

    it("clears the selected item, usage units, availability, source location, quantity, idempotency key, AND the cart -- never carries Station A's prepared withdrawal into Station B", () => {
      const state = stateWithInProgressWithdrawal();
      const changed = kioskReducer(state, { type: "REQUEST_CHANGE_STATION" });

      expect(changed.step).toBe("station_picker");
      expect(changed.selectedItem).toBeNull();
      expect(changed.usageUnits).toBeNull();
      expect(changed.selectedUsageUnitId).toBeNull();
      expect(changed.withdrawalUnitUnavailable).toBe(false);
      expect(changed.availableLocations).toBeNull();
      expect(changed.selectedSourceLocationId).toBeNull();
      expect(changed.enteredQuantity).toBe("");
      expect(changed.clientRequestId).toBeNull();
      expect(changed.cart).toEqual([]);
    });

    it("preserves employee/session identity -- only the in-progress withdrawal and step change", () => {
      const state = stateWithInProgressWithdrawal();
      const changed = kioskReducer(state, { type: "REQUEST_CHANGE_STATION" });

      expect(changed.kioskToken).toBe(state.kioskToken);
      expect(changed.employeeFirstName).toBe(state.employeeFirstName);
      expect(changed.selectedStationId).toBe(state.selectedStationId); // unchanged until STATION_SELECTED
    });

    it("is a no-op on the already-empty fields when nothing was in progress (the immediately-post-login case)", () => {
      const state = pinVerifiedState({ step: "station_resolving" });
      const changed = kioskReducer(state, { type: "REQUEST_CHANGE_STATION" });
      expect(changed.step).toBe("station_picker");
      expect(changed.selectedItem).toBeNull();
      expect(changed.enteredQuantity).toBe("");
    });

    it("end-to-end: change station mid-withdrawal, pick a new station, and the session now reflects the NEW station with a clean slate", () => {
      const state = stateWithInProgressWithdrawal();
      let next = kioskReducer(state, { type: "REQUEST_CHANGE_STATION" });
      next = kioskReducer(next, { type: "STATION_SELECTED", stationId: "station-2", stationName: "Grill" });

      expect(next.step).toBe("item_select");
      expect(next.selectedStationId).toBe("station-2");
      expect(next.selectedStationName).toBe("Grill");
      expect(next.selectedItem).toBeNull();
      expect(next.enteredQuantity).toBe("");
    });
  });

  // The temporary session override from Change Station must never survive
  // a real reset -- the employee's PERMANENT default station lives only in
  // the database (re-resolved fresh on the next PIN_VERIFIED), never in
  // client state that could leak across sessions.
  describe("temporary station override does not survive Start Over (2A.5)", () => {
    it("START_OVER after a mid-session station change returns to a clean slate with no station carried over", () => {
      let state = pinVerifiedState(); // resolves to the employee's real default (e.g. "station-1")
      state = kioskReducer(state, { type: "REQUEST_CHANGE_STATION" });
      state = kioskReducer(state, { type: "STATION_SELECTED", stationId: "station-2", stationName: "Grill" });
      expect(state.selectedStationId).toBe("station-2"); // the temporary override took effect

      const afterStartOver = kioskReducer(state, { type: "START_OVER" });
      const fresh = createInitialKioskState();
      expect(afterStartOver.selectedStationId).toBe(fresh.selectedStationId);
      expect(afterStartOver.selectedStationId).toBeNull();
      expect(afterStartOver.kioskToken).toBeNull();
      // The next PIN_VERIFIED (a fresh login) is what re-resolves the
      // employee's real default -- proven by the existing PIN_VERIFIED
      // test above; nothing here is left over to interfere with that.
    });
  });

  // Milestone 2A.5 multi-item withdrawal cart.
  describe("multi-item withdrawal cart", () => {
    const ITEM = { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat", baseUnitCode: "LB", totalAvailableQuantity: 10, positiveLocationCount: 1, singleLocation: null };
    const LOC_A = { locationId: "loc-a", locationName: "Central Walk-In", baseUnitCode: "LB", balance: 56, fullReferenceQuantity: 72, includesLegacyEstimate: false };
    const LOC_B = { locationId: "loc-b", locationName: "Central Freezer", baseUnitCode: "LB", balance: 20, fullReferenceQuantity: 40, includesLegacyEstimate: false };

    function stateReadyToAdd(quantity: string, location = LOC_A) {
      let state = pinVerifiedState({ items: [ITEM] });
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [location] });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: quantity });
      return state;
    }

    it("1. ADD_TO_CART adds the first line and returns to item_select", () => {
      const state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "item_select" });
      expect(state.step).toBe("item_select");
      expect(state.cart).toEqual([
        { id: "item-1::loc-a", inventoryItemId: "item-1", itemName: "Chicken Thigh", categoryName: "Meat", sourceLocationId: "loc-a", sourceLocationName: "Central Walk-In", enteredQuantity: "5", enteredUnitId: "unit-lb", unitCode: "LB" },
      ]);
      expect(state.selectedItem).toBeNull();
    });

    it("ADD_TO_CART uses the SECONDARY unit's id/code when the employee selected it", () => {
      let state = pinVerifiedState({ items: [ITEM] });
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS_WITH_SECONDARY });
      state = kioskReducer(state, { type: "USAGE_UNIT_SELECTED", unitId: "unit-case" });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "2" });
      state = kioskReducer(state, { type: "ADD_TO_CART", nextStep: "item_select" });

      expect(state.cart).toEqual([
        { id: "item-1::loc-a", inventoryItemId: "item-1", itemName: "Chicken Thigh", categoryName: "Meat", sourceLocationId: "loc-a", sourceLocationName: "Central Walk-In", enteredQuantity: "2", enteredUnitId: "unit-case", unitCode: "CASE" },
      ]);
    });

    it("2. ADD_TO_CART adds a second, different item as its own line", () => {
      const ITEM_2 = { ...ITEM, id: "item-2", name: "Heavy Cream" };
      let state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "item_select" });
      state = { ...state, items: [ITEM, ITEM_2] };
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM_2 });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "10" });
      state = kioskReducer(state, { type: "ADD_TO_CART", nextStep: "item_select" });

      expect(state.cart).toHaveLength(2);
      expect(state.cart.map((l) => l.itemName)).toEqual(["Chicken Thigh", "Heavy Cream"]);
    });

    it("3. adding the SAME item + SAME source again combines the quantity (5 + 3 = 8), not a duplicate row", () => {
      let state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "item_select" });
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "3" });
      state = kioskReducer(state, { type: "ADD_TO_CART", nextStep: "item_select" });

      expect(state.cart).toHaveLength(1);
      expect(state.cart[0].enteredQuantity).toBe("8");
    });

    it("4. the SAME item from a DIFFERENT source stays a separate line", () => {
      let state = kioskReducer(stateReadyToAdd("5", LOC_A), { type: "ADD_TO_CART", nextStep: "item_select" });
      state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_B] });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "3" });
      state = kioskReducer(state, { type: "ADD_TO_CART", nextStep: "item_select" });

      expect(state.cart).toHaveLength(2);
      expect(state.cart.map((l) => [l.sourceLocationId, l.enteredQuantity])).toEqual([
        ["loc-a", "5"],
        ["loc-b", "3"],
      ]);
    });

    it("5. EDIT_CART_LINE then SAVE_CART_LINE_EDIT changes only the selected line, returning to review", () => {
      let state = pinVerifiedState({
        items: [ITEM],
        cart: [makeCartLine({ id: "item-1::loc-a", enteredQuantity: "5" }), makeCartLine({ id: "item-2::loc-a", inventoryItemId: "item-2", itemName: "Untouched Item" })],
        step: "review",
      });
      state = kioskReducer(state, { type: "EDIT_CART_LINE", lineId: "item-1::loc-a" });
      expect(state.step).toBe("quantity_entry");
      expect(state.editingCartLineId).toBe("item-1::loc-a");
      expect(state.enteredQuantity).toBe("5"); // pre-populated from the existing line
      expect(state.selectedSourceLocationId).toBe("loc-a"); // pre-selected

      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
      state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
      expect(state.selectedSourceLocationId).toBe("loc-a"); // preserved across the fresh reload
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "9" });
      state = kioskReducer(state, { type: "SAVE_CART_LINE_EDIT", nextStep: "review" });

      expect(state.step).toBe("review");
      expect(state.editingCartLineId).toBeNull();
      expect(state.cart.find((l) => l.id === "item-1::loc-a")?.enteredQuantity).toBe("9");
      expect(state.cart.find((l) => l.id === "item-2::loc-a")?.itemName).toBe("Untouched Item"); // unrelated line unchanged
    });

    it("EDIT_CART_LINE tentatively preserves the line's own entered unit as the selection once USAGE_UNITS_LOADED confirms it's still a valid option", () => {
      let state = pinVerifiedState({
        items: [ITEM],
        cart: [makeCartLine({ id: "item-1::loc-a", enteredUnitId: "unit-case", unitCode: "CASE" })],
        step: "review",
      });
      state = kioskReducer(state, { type: "EDIT_CART_LINE", lineId: "item-1::loc-a" });
      // Tentative, before the authoritative options arrive.
      expect(state.selectedUsageUnitId).toBe("unit-case");

      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS_WITH_SECONDARY });
      expect(state.selectedUsageUnitId).toBe("unit-case"); // preserved -- still a genuine option (secondary)
    });

    it("EDIT_CART_LINE's tentative unit falls back to primary once USAGE_UNITS_LOADED reveals it's no longer a valid option (e.g. the secondary was deactivated)", () => {
      let state = pinVerifiedState({
        items: [ITEM],
        cart: [makeCartLine({ id: "item-1::loc-a", enteredUnitId: "unit-case", unitCode: "CASE" })],
        step: "review",
      });
      state = kioskReducer(state, { type: "EDIT_CART_LINE", lineId: "item-1::loc-a" });
      state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS }); // one-unit item now -- no secondary
      expect(state.selectedUsageUnitId).toBe("unit-lb"); // fell back to primary
    });

    it("CANCEL_CART_LINE_EDIT returns to review without mutating the cart", () => {
      let state = pinVerifiedState({ items: [ITEM], cart: [makeCartLine({ enteredQuantity: "5" })], step: "review" });
      state = kioskReducer(state, { type: "EDIT_CART_LINE", lineId: "item-1::loc-a" });
      state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "999" });
      state = kioskReducer(state, { type: "CANCEL_CART_LINE_EDIT" });

      expect(state.step).toBe("review");
      expect(state.cart).toEqual([makeCartLine({ enteredQuantity: "5" })]);
    });

    it("6. REMOVE_CART_LINE removes only the targeted line", () => {
      let state = pinVerifiedState({
        items: [ITEM],
        cart: [makeCartLine({ id: "item-1::loc-a" }), makeCartLine({ id: "item-2::loc-a", inventoryItemId: "item-2", itemName: "Other Item" })],
        step: "review",
      });
      state = kioskReducer(state, { type: "REMOVE_CART_LINE", lineId: "item-1::loc-a" });

      expect(state.cart).toEqual([makeCartLine({ id: "item-2::loc-a", inventoryItemId: "item-2", itemName: "Other Item" })]);
      expect(state.step).toBe("review"); // cart still non-empty
    });

    it("REMOVE_CART_LINE returns to item_select once the cart becomes empty", () => {
      let state = pinVerifiedState({ items: [ITEM], cart: [makeCartLine()], step: "review" });
      state = kioskReducer(state, { type: "REMOVE_CART_LINE", lineId: "item-1::loc-a" });

      expect(state.cart).toEqual([]);
      expect(state.step).toBe("item_select");
    });

    it("CLEAR_CART empties the cart and returns to item_select", () => {
      let state = pinVerifiedState({ items: [ITEM], cart: [makeCartLine(), makeCartLine({ id: "item-2::loc-a", inventoryItemId: "item-2" })], step: "review" });
      state = kioskReducer(state, { type: "CLEAR_CART" });

      expect(state.cart).toEqual([]);
      expect(state.step).toBe("item_select");
    });

    it("7. Continue Shopping (BACK_TO_ITEMS) preserves the cart", () => {
      let state = pinVerifiedState({ items: [ITEM], cart: [makeCartLine()], step: "review" });
      state = kioskReducer(state, { type: "BACK_TO_ITEMS" });

      expect(state.step).toBe("item_select");
      expect(state.cart).toEqual([makeCartLine()]);
    });

    it("8. REQUEST_CHANGE_STATION with a non-empty cart clears it (confirmation is a UI-layer concern, not the reducer's)", () => {
      let state = pinVerifiedState({ cart: [makeCartLine()] });
      state = kioskReducer(state, { type: "REQUEST_CHANGE_STATION" });
      expect(state.cart).toEqual([]);
    });

    it("9. START_OVER with a non-empty cart discards it (confirmation is a UI-layer concern, not the reducer's)", () => {
      let state = pinVerifiedState({ cart: [makeCartLine()] });
      state = kioskReducer(state, { type: "START_OVER" });
      expect(state.cart).toEqual([]);
    });

    it("OPEN_REVIEW moves to the review step", () => {
      const state = kioskReducer(pinVerifiedState({ cart: [makeCartLine()] }), { type: "OPEN_REVIEW" });
      expect(state.step).toBe("review");
    });

    it("27. WITHDRAW_MORE keeps employee/station/kioskToken but starts an empty cart and forces items/recent to refetch", () => {
      let state = pinVerifiedState({
        cart: [],
        successSummary: { itemCount: 2, stationName: "Grill" },
        items: [ITEM],
        recentItemIds: ["item-1"],
      });
      state = kioskReducer(state, { type: "WITHDRAW_MORE" });

      expect(state.step).toBe("item_select");
      expect(state.successSummary).toBeNull();
      expect(state.items).toBeNull();
      expect(state.recentItemIds).toBeNull();
      expect(state.kioskToken).toBe("token-1");
      expect(state.employeeFirstName).toBe("Maria");
      expect(state.selectedStationId).toBe("station-1");
    });

    it("28. a cart edit after a failed submit clears the stale clientRequestId and error, so a retry never conflicts with the old rejected payload", () => {
      let state = pinVerifiedState({ items: [ITEM], cart: [makeCartLine()], step: "review" });
      state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
      state = kioskReducer(state, { type: "SUBMIT_FAILED", message: "Inventory changed." });
      expect(state.clientRequestId).toBe("req-1");

      state = kioskReducer(state, { type: "REMOVE_CART_LINE", lineId: "item-1::loc-a" });
      expect(state.clientRequestId).toBeNull();
      expect(state.errorBanner).toBeNull();
    });

    // Dual completion paths from quantity entry: "Add & Continue Shopping"
    // and "Add & Review Withdrawal" perform the IDENTICAL cart mutation
    // (ADD_TO_CART/SAVE_CART_LINE_EDIT) and differ ONLY in nextStep.
    describe("dual completion paths (Add/Save & Continue Shopping vs. Add/Save & Review Withdrawal)", () => {
      it("1. ADD_TO_CART with nextStep item_select adds the item and returns to inventory browsing", () => {
        const state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "item_select" });
        expect(state.step).toBe("item_select");
        expect(state.cart).toHaveLength(1);
      });

      it("2. ADD_TO_CART with nextStep review adds the item and goes DIRECTLY to Review Withdrawal, never through browsing", () => {
        const state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "review" });
        expect(state.step).toBe("review");
        expect(state.cart).toHaveLength(1);
        expect(state.cart[0]).toMatchObject({ inventoryItemId: "item-1", enteredQuantity: "5" });
      });

      it("3. a ONE-item cart works end-to-end through Add & Review alone: PIN -> item -> quantity -> Add & Review -> review, no separate browsing/cart-button step required", () => {
        const state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "review" });
        expect(state.step).toBe("review");
        expect(state.cart).toEqual([
          { id: "item-1::loc-a", inventoryItemId: "item-1", itemName: "Chicken Thigh", categoryName: "Meat", sourceLocationId: "loc-a", sourceLocationName: "Central Walk-In", enteredQuantity: "5", enteredUnitId: "unit-lb", unitCode: "LB" },
        ]);
      });

      it("4. an existing multi-item cart is preserved when a later item is added via EITHER path", () => {
        const existing = [makeCartLine({ id: "item-9::loc-a", inventoryItemId: "item-9", itemName: "Existing Item" })];
        const viaContinue = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "item_select" });
        const withExisting = { ...stateReadyToAdd("5"), cart: existing };
        const viaReview = kioskReducer(withExisting, { type: "ADD_TO_CART", nextStep: "review" });

        expect(viaContinue.cart.map((l) => l.inventoryItemId)).toEqual(["item-1"]);
        expect(viaReview.cart.map((l) => l.inventoryItemId).sort()).toEqual(["item-1", "item-9"]);
      });

      it("5. same item + same source combine identically through EITHER path", () => {
        let state = kioskReducer(stateReadyToAdd("5"), { type: "ADD_TO_CART", nextStep: "item_select" });
        state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM });
        state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
        state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
        state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "3" });
        state = kioskReducer(state, { type: "ADD_TO_CART", nextStep: "review" }); // second add uses the OTHER path

        expect(state.cart).toHaveLength(1);
        expect(state.cart[0].enteredQuantity).toBe("8"); // 5 + 3, same as the item_select-only path
        expect(state.step).toBe("review");
      });

      it("6. same item from a DIFFERENT source remains a separate line via Add & Review", () => {
        let state = kioskReducer(stateReadyToAdd("5", LOC_A), { type: "ADD_TO_CART", nextStep: "item_select" });
        state = kioskReducer(state, { type: "ITEM_SELECTED", item: ITEM });
        state = kioskReducer(state, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
        state = kioskReducer(state, { type: "AVAILABILITY_LOADED", locations: [LOC_B] });
        state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "3" });
        state = kioskReducer(state, { type: "ADD_TO_CART", nextStep: "review" });

        expect(state.cart).toHaveLength(2);
        expect(state.cart.map((l) => l.sourceLocationId)).toEqual(["loc-a", "loc-b"]);
      });

      it("9. edit mode with SAVE_CART_LINE_EDIT updates the existing line rather than duplicating it, through either nextStep", () => {
        const base = pinVerifiedState({
          items: [ITEM],
          cart: [makeCartLine({ id: "item-1::loc-a", enteredQuantity: "5" })],
          step: "review",
        });

        let viaReview = kioskReducer(base, { type: "EDIT_CART_LINE", lineId: "item-1::loc-a" });
        viaReview = kioskReducer(viaReview, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
        viaReview = kioskReducer(viaReview, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
        viaReview = kioskReducer(viaReview, { type: "QUANTITY_CHANGED", value: "9" });
        viaReview = kioskReducer(viaReview, { type: "SAVE_CART_LINE_EDIT", nextStep: "review" });
        expect(viaReview.cart).toHaveLength(1); // updated, not duplicated
        expect(viaReview.cart[0].enteredQuantity).toBe("9");
        expect(viaReview.step).toBe("review");

        let viaShopping = kioskReducer(base, { type: "EDIT_CART_LINE", lineId: "item-1::loc-a" });
        viaShopping = kioskReducer(viaShopping, { type: "USAGE_UNITS_LOADED", units: USAGE_UNITS });
        viaShopping = kioskReducer(viaShopping, { type: "AVAILABILITY_LOADED", locations: [LOC_A] });
        viaShopping = kioskReducer(viaShopping, { type: "QUANTITY_CHANGED", value: "7" });
        viaShopping = kioskReducer(viaShopping, { type: "SAVE_CART_LINE_EDIT", nextStep: "item_select" });
        expect(viaShopping.cart).toHaveLength(1); // updated, not duplicated
        expect(viaShopping.cart[0].enteredQuantity).toBe("7");
        expect(viaShopping.step).toBe("item_select");
      });
    });
  });
});
