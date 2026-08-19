"use client";

interface EmployeeStatusBarProps {
  employeeFirstName: string;
  stationName: string | null;
  onStartOver: () => void;
  /** Only offered when the employee's config allows it (can_change_station)
   * -- a locked employee never sees this, matching the pre-2A.5 station-
   * resolving screen's own gating. */
  canChangeStation: boolean;
  onChangeStation: () => void;
  /** Small, optional per-screen context caption (e.g. "Inventory") folded
   * into this same compact header instead of a separate standalone
   * heading -- keeps screen context available without adding a whole
   * extra heading row elsewhere on the page. */
  screenLabel?: string;
  /** Multi-item cart (2A.5 Part 3). Zero hides the control entirely --
   * there is nothing to review yet. */
  cartCount: number;
  onOpenReview: () => void;
}

/**
 * Persistent identity + CURRENT STATION strip shown throughout the
 * post-PIN withdrawal flow -- the employee must always be able to tell
 * whose withdrawal, and at which station, is being recorded, and (2A.5)
 * must be able to change the SESSION's station from any authenticated
 * screen without returning to login. KioskApp only mounts this while
 * state.step is neither "pin" nor "success", and every reset path
 * (START_OVER, SESSION_EXPIRED, SUBMIT_SUCCESS) routes through one of
 * those two steps, which is what "clears it completely" in practice --
 * a station changed here is a purely client-side SESSION override; the
 * employee's permanent default_station_id in the database is never
 * touched, so the next fresh PIN entry always resolves back to it.
 */
export function EmployeeStatusBar({
  employeeFirstName,
  stationName,
  onStartOver,
  canChangeStation,
  onChangeStation,
  screenLabel,
  cartCount,
  onOpenReview,
}: EmployeeStatusBarProps) {
  return (
    <div className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-2xl border border-kiosk-blue/20 bg-kiosk-blue/10 px-5 py-3">
      <div>
        {screenLabel ? (
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-kiosk-text-subtle">{screenLabel}</p>
        ) : null}
        <p className="text-base font-medium text-kiosk-text-muted">
          Hi, <span className="text-lg font-semibold text-kiosk-text">{employeeFirstName}</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        {stationName ? (
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-kiosk-text-subtle">Current Station</p>
            <p className="text-sm font-semibold text-kiosk-blue-strong">{stationName}</p>
          </div>
        ) : null}
        {cartCount > 0 ? (
          <button
            type="button"
            onClick={onOpenReview}
            className="rounded-full bg-kiosk-amber px-4 py-1.5 text-sm font-semibold text-kiosk-amber-ink transition hover:bg-kiosk-amber-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber-strong"
          >
            Withdrawal · {cartCount}
          </button>
        ) : null}
        <div className="flex items-center gap-1">
          {canChangeStation ? (
            <>
              <button
                type="button"
                onClick={onChangeStation}
                className="rounded-full px-3 py-1.5 text-sm font-medium text-kiosk-text-subtle transition hover:bg-kiosk-surface-raised hover:text-kiosk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
              >
                Change Station
              </button>
              <span className="text-kiosk-border-strong" aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <button
            type="button"
            onClick={onStartOver}
            className="rounded-full px-3 py-1.5 text-sm font-medium text-kiosk-text-subtle transition hover:bg-kiosk-surface-raised hover:text-kiosk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
          >
            Start Over
          </button>
        </div>
      </div>
    </div>
  );
}
