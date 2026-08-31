import { describe, expect, it } from "vitest";
import { resolveStationBranch } from "@/app/kiosk/_lib/stationBranch";

// CI-safe: pure logic, no network, no database.
//
// Kiosk station assignment enforcement (20260811100130): resolveStationBranch
// is now a trivial, fully deterministic mapping from StationAccess (itself
// derived server-side, in verifyPinCore, from the employee's CURRENT active
// station assignments) -- no more auto_resolve_station/can_change_station
// flags, no more "auto_changeable" escape hatch onto every organization
// station.

describe("resolveStationBranch", () => {
  it("blocked: zero active assignments", () => {
    const branch = resolveStationBranch({ kind: "blocked" });
    expect(branch).toEqual({ kind: "blocked" });
  });

  it("locked: exactly one active assignment auto-selects, with no further choice offered", () => {
    const branch = resolveStationBranch({ kind: "single", stationId: "station-1", stationName: "Grill" });
    expect(branch).toEqual({ kind: "locked", stationId: "station-1", stationName: "Grill" });
  });

  it("must_pick: two or more active assignments require an explicit choice", () => {
    const branch = resolveStationBranch({ kind: "multiple" });
    expect(branch).toEqual({ kind: "must_pick" });
  });
});
