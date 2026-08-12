import { describe, expect, it } from "vitest";
import { createInitialKioskState, kioskReducer, type KioskState } from "@/app/kiosk/_lib/kioskReducer";

// CI-safe: pure reducer logic, no network, no database.

const STATION_CONFIG = {
  defaultStationId: "station-1",
  defaultStationName: "Grill",
  autoResolveStation: true,
  canChangeStation: false,
};

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

  it("WITHDRAWAL_UNIT_LOADED populates the item's canonical withdrawal unit and resets enteredQuantity", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" },
    });
    state = kioskReducer(state, { type: "WITHDRAWAL_UNIT_LOADED", unit: { baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" } });
    expect(state.withdrawalUnit).toEqual({ baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" });
    expect(state.enteredQuantity).toBe("");
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
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" },
    });
    state = kioskReducer(state, { type: "WITHDRAWAL_UNIT_UNAVAILABLE" });

    expect(state.step).toBe("quantity_entry");
    expect(state.withdrawalUnitUnavailable).toBe(true);
    expect(state.withdrawalUnit).toBeNull();
    expect(state.errorBanner).toBeNull();
    expect(state.selectedItem).toEqual({ id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" });
  });

  it("ITEM_SELECTED and BACK_TO_ITEMS clear withdrawalUnitUnavailable, so a fresh item selection re-attempts the fetch", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" },
    });
    state = kioskReducer(state, { type: "WITHDRAWAL_UNIT_UNAVAILABLE" });
    expect(state.withdrawalUnitUnavailable).toBe(true);

    const backToItems = kioskReducer(state, { type: "BACK_TO_ITEMS" });
    expect(backToItems.withdrawalUnitUnavailable).toBe(false);

    const reselected = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-2", name: "Eggs", categoryId: "cat-2", categoryName: "Dairy" },
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
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" },
    });
    state = kioskReducer(state, {
      type: "WITHDRAWAL_UNIT_LOADED",
      unit: { baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" },
    });
    const before = state;
    const after = kioskReducer(before, { type: "QUANTITY_CHANGED", value: "43.6" });

    expect(after.enteredQuantity).toBe("43.6");
    // Every other field must be untouched: overwriting enteredQuantity back
    // to its pre-change value should make `after` deep-equal `before`.
    expect({ ...after, enteredQuantity: before.enteredQuantity }).toEqual(before);
  });

  it("ITEM_SELECTED clears any previously loaded withdrawal unit/quantity for the prior item", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" },
    });
    state = kioskReducer(state, {
      type: "WITHDRAWAL_UNIT_LOADED",
      unit: { baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" },
    });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "2" });

    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-2", name: "Eggs", categoryId: "cat-2", categoryName: "Dairy" },
    });
    expect(state.withdrawalUnit).toBeNull();
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

  it("BACK_TO_QUANTITY clears clientRequestId -- editing inputs starts a new attempt", () => {
    let state = pinVerifiedState({ step: "review" });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    state = kioskReducer(state, { type: "BACK_TO_QUANTITY" });
    expect(state.clientRequestId).toBeNull();
    expect(state.step).toBe("quantity_entry");
  });

  it("SUBMIT_SUCCESS clears employee/station identity completely, not just the visible screen, and moves to the success step", () => {
    let state = pinVerifiedState({ step: "review" });
    state = kioskReducer(state, {
      type: "WITHDRAWAL_UNIT_LOADED",
      unit: { baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" },
    });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    state = kioskReducer(state, { type: "SUBMIT_SUCCESS" });

    expect(state.step).toBe("success");
    expect(state.submitting).toBe(false);
    expect(state.clientRequestId).toBeNull();
    expect(state.kioskToken).toBeNull();
    expect(state.employeeDisplayName).toBeNull();
    expect(state.employeeFirstName).toBeNull();
    expect(state.stationConfig).toBeNull();
    expect(state.selectedStationId).toBeNull();
    expect(state.selectedStationName).toBeNull();
    expect(state.selectedItem).toBeNull();
    expect(state.withdrawalUnit).toBeNull();
    expect(state.enteredQuantity).toBe("");
  });

  it("START_OVER fully resets every field back to the initial state shape", () => {
    let state = pinVerifiedState({ step: "review" });
    state = kioskReducer(state, {
      type: "WITHDRAWAL_UNIT_LOADED",
      unit: { baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" },
    });
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
    expect(state.withdrawalUnit).toBeNull();
    expect(state.clientRequestId).toBeNull();
    expect(state.errorBanner).toBeNull();
  });

  it("SESSION_EXPIRED fully resets state (identity must disappear, not just the visible screen) and sets a banner", () => {
    let state = pinVerifiedState({ step: "quantity_entry" });
    state = kioskReducer(state, {
      type: "WITHDRAWAL_UNIT_LOADED",
      unit: { baseUnitId: "unit-lb", baseUnitCode: "LB", baseUnitName: "Pound", baseUnitType: "WEIGHT" },
    });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "5" });
    state = kioskReducer(state, { type: "SESSION_EXPIRED" });

    expect(state.step).toBe("pin");
    expect(state.kioskToken).toBeNull();
    expect(state.employeeDisplayName).toBeNull();
    expect(state.employeeFirstName).toBeNull();
    expect(state.selectedStationName).toBeNull();
    expect(state.withdrawalUnit).toBeNull();
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
});
