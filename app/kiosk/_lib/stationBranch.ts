/**
 * Pure station-branching logic (see docs/PRODUCT.md / CLAUDE.md "STATION
 * LOGIC" and the approved kiosk UI plan §2). Driven entirely by the
 * employee's station config, now returned directly by verifyPin.
 *
 * The backend (record_inventory_withdrawal) is the actual authorization
 * boundary -- it independently re-validates the station on every submit
 * regardless of what this function decides. This only drives which screens
 * the employee sees; it must never be treated as a security control.
 */

export interface StationConfig {
  defaultStationId: string | null;
  defaultStationName: string | null;
  autoResolveStation: boolean;
  canChangeStation: boolean;
}

export type StationBranch =
  | { kind: "locked"; stationId: string; stationName: string | null }
  | { kind: "auto_changeable"; stationId: string; stationName: string | null }
  | { kind: "must_pick" };

export function resolveStationBranch(config: StationConfig): StationBranch {
  if (config.autoResolveStation && config.defaultStationId) {
    return config.canChangeStation
      ? { kind: "auto_changeable", stationId: config.defaultStationId, stationName: config.defaultStationName }
      : { kind: "locked", stationId: config.defaultStationId, stationName: config.defaultStationName };
  }
  // Also covers the defensive case of autoResolveStation=true with no
  // defaultStationId -- shouldn't happen given the DB check constraint, but
  // the UI should not trust a stale/cached config blindly.
  return { kind: "must_pick" };
}
