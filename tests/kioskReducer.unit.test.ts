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

  it("UNIT_CHANGED resets enteredQuantity and measuredBaseQuantity so a stale number can never carry across a unit switch", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "2" });
    state = kioskReducer(state, { type: "MEASURED_QUANTITY_CHANGED", value: "43.6" });
    expect(state.enteredQuantity).toBe("2");
    expect(state.measuredBaseQuantity).toBe("43.6");

    state = kioskReducer(state, { type: "UNIT_CHANGED", unitId: "unit-2" });
    expect(state.selectedUnitId).toBe("unit-2");
    expect(state.enteredQuantity).toBe("");
    expect(state.measuredBaseQuantity).toBeNull();
  });

  it("ITEM_SELECTED clears any previously loaded units/quantity for the prior item", () => {
    let state = pinVerifiedState();
    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-1", name: "Chicken Thigh", categoryId: "cat-1", categoryName: "Meat" },
    });
    state = kioskReducer(state, {
      type: "ITEM_UNITS_LOADED",
      units: [{ unitId: "unit-1", unitCode: "BOX", unitName: "Box", conversionFactor: null, requiresActualMeasurement: true, isDefaultEntryUnit: true }],
      defaultUnitId: "unit-1",
      baseUnitName: "Pound",
    });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "2" });

    state = kioskReducer(state, {
      type: "ITEM_SELECTED",
      item: { id: "item-2", name: "Eggs", categoryId: "cat-2", categoryName: "Dairy" },
    });
    expect(state.itemUnits).toBeNull();
    expect(state.baseUnitName).toBeNull();
    expect(state.selectedUnitId).toBeNull();
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

  it("SUBMIT_SUCCESS clears clientRequestId and moves to the success step", () => {
    let state = pinVerifiedState({ step: "review" });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    state = kioskReducer(state, { type: "SUBMIT_SUCCESS" });
    expect(state.clientRequestId).toBeNull();
    expect(state.step).toBe("success");
    expect(state.submitting).toBe(false);
  });

  it("START_OVER fully resets every field back to the initial state shape", () => {
    let state = pinVerifiedState({ step: "review" });
    state = kioskReducer(state, { type: "SUBMIT_ATTEMPT_STARTED", clientRequestId: "req-1" });
    state = kioskReducer(state, { type: "START_OVER" });

    const fresh = createInitialKioskState();
    expect(state.step).toBe(fresh.step);
    expect(state.kioskToken).toBeNull();
    expect(state.employeeDisplayName).toBeNull();
    expect(state.stationConfig).toBeNull();
    expect(state.selectedStationId).toBeNull();
    expect(state.selectedItem).toBeNull();
    expect(state.clientRequestId).toBeNull();
    expect(state.errorBanner).toBeNull();
  });

  it("SESSION_EXPIRED fully resets state (identity must disappear, not just the visible screen) and sets a banner", () => {
    let state = pinVerifiedState({ step: "quantity_entry" });
    state = kioskReducer(state, { type: "QUANTITY_CHANGED", value: "5" });
    state = kioskReducer(state, { type: "SESSION_EXPIRED" });

    expect(state.step).toBe("pin");
    expect(state.kioskToken).toBeNull();
    expect(state.employeeDisplayName).toBeNull();
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
