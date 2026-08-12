"use client";

import type { ReactNode } from "react";

interface KioskShellProps {
  children: ReactNode;
  onActivity: () => void;
}

/**
 * Pins the whole kiosk to the true viewport (`fixed inset-0`) and never
 * lets the browser page itself scroll -- there is deliberately no
 * body-level scrollbar to fight with. Every screen manages its own scroll
 * region internally (see KioskScreen); this shell only owns the outer
 * frame and is the single place activity is observed for the
 * session-refresh scheduler (app/kiosk/_lib/sessionRefresh.ts) --
 * pointer/keyboard events anywhere in the kiosk count as "the employee is
 * still here," regardless of which screen is active.
 */
export function KioskShell({ children, onActivity }: KioskShellProps) {
  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-kiosk-bg text-kiosk-text"
      onPointerDown={onActivity}
      onKeyDown={onActivity}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-6 pt-6 sm:px-10 sm:pt-8">{children}</div>
    </div>
  );
}
