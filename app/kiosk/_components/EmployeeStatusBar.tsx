"use client";

interface EmployeeStatusBarProps {
  employeeFirstName: string;
  stationName: string | null;
  onStartOver: () => void;
  /** Small, optional per-screen context caption (e.g. "Inventory") folded
   * into this same compact header instead of a separate standalone
   * heading -- keeps screen context available without adding a whole
   * extra heading row elsewhere on the page. */
  screenLabel?: string;
}

/**
 * Persistent identity strip shown throughout the post-PIN withdrawal flow
 * (refined kiosk UX plan §1) -- the employee must always be able to tell
 * whose withdrawal is being recorded. KioskApp only mounts this while
 * state.step is neither "pin" nor "success", and every reset path
 * (START_OVER, SESSION_EXPIRED, SUBMIT_SUCCESS) routes through one of those
 * two steps, which is what "clears it completely" in practice.
 */
export function EmployeeStatusBar({ employeeFirstName, stationName, onStartOver, screenLabel }: EmployeeStatusBarProps) {
  return (
    <div className="mb-3 flex shrink-0 items-start justify-between gap-4 rounded-2xl border border-kiosk-blue/20 bg-kiosk-blue/10 px-5 py-3">
      <div>
        {screenLabel ? (
          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-kiosk-text-subtle">{screenLabel}</p>
        ) : null}
        <p className="text-base font-medium text-kiosk-text-muted">
          Hi, <span className="text-lg font-semibold text-kiosk-text">{employeeFirstName}</span>
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        {stationName ? <p className="text-sm font-semibold text-kiosk-blue-strong">{stationName}</p> : null}
        <button
          type="button"
          onClick={onStartOver}
          className="rounded-full px-3 py-1.5 text-sm font-medium text-kiosk-text-subtle transition hover:bg-kiosk-surface-raised hover:text-kiosk-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kiosk-amber"
        >
          Start Over
        </button>
      </div>
    </div>
  );
}
