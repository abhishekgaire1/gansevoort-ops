import { describe, expect, it } from "vitest";
import { resolveStationBranch } from "@/app/kiosk/_lib/stationBranch";

// CI-safe: pure logic, no network, no database.

describe("resolveStationBranch", () => {
  it("locked: auto_resolve_station=true, can_change_station=false", () => {
    const branch = resolveStationBranch({
      defaultStationId: "station-1",
      defaultStationName: "Grill",
      autoResolveStation: true,
      canChangeStation: false,
    });
    expect(branch).toEqual({ kind: "locked", stationId: "station-1", stationName: "Grill" });
  });

  it("auto_changeable: auto_resolve_station=true, can_change_station=true", () => {
    const branch = resolveStationBranch({
      defaultStationId: "station-1",
      defaultStationName: "Grill",
      autoResolveStation: true,
      canChangeStation: true,
    });
    expect(branch).toEqual({ kind: "auto_changeable", stationId: "station-1", stationName: "Grill" });
  });

  it("must_pick: auto_resolve_station=false", () => {
    const branch = resolveStationBranch({
      defaultStationId: null,
      defaultStationName: null,
      autoResolveStation: false,
      canChangeStation: false,
    });
    expect(branch).toEqual({ kind: "must_pick" });
  });

  it("defensive: auto_resolve_station=true but no defaultStationId falls back to must_pick rather than crashing", () => {
    const branch = resolveStationBranch({
      defaultStationId: null,
      defaultStationName: null,
      autoResolveStation: true,
      canChangeStation: false,
    });
    expect(branch).toEqual({ kind: "must_pick" });
  });
});
