/**
 * Pure station-branching logic (see docs/PRODUCT.md / CLAUDE.md "STATION
 * LOGIC" and the approved kiosk UI plan §2). Kiosk station assignment
 * enforcement (20260811100130): driven entirely by the employee's CURRENT
 * active station assignments, returned directly by verifyPin as
 * StationAccess -- never a client-side guess and never "every
 * organization station."
 *
 * The backend (record_inventory_withdrawal) is the actual authorization
 * boundary -- it independently re-validates the station on every submit
 * regardless of what this function decides. This only drives which screens
 * the employee sees; it must never be treated as a security control.
 */

import type { StationAccess } from "@/app/lib/auth/verifyPin";

export type StationBranch =
  | { kind: "blocked" }
  | { kind: "locked"; stationId: string; stationName: string }
  | { kind: "must_pick" };

export function resolveStationBranch(stationAccess: StationAccess): StationBranch {
  if (stationAccess.kind === "blocked") {
    return { kind: "blocked" };
  }
  if (stationAccess.kind === "single") {
    return { kind: "locked", stationId: stationAccess.stationId, stationName: stationAccess.stationName };
  }
  return { kind: "must_pick" };
}
