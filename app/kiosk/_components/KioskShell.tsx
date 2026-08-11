"use client";

import type { ReactNode } from "react";

interface KioskShellProps {
  children: ReactNode;
  onActivity: () => void;
}

/**
 * Full-bleed visual frame. Also the single place activity is observed for
 * the session-refresh scheduler (app/kiosk/_lib/sessionRefresh.ts) --
 * pointer/keyboard events anywhere in the kiosk count as "the employee is
 * still here," regardless of which screen is active.
 */
export function KioskShell({ children, onActivity }: KioskShellProps) {
  return (
    <div
      className="flex min-h-screen w-full flex-col bg-zinc-950 text-zinc-50"
      onPointerDown={onActivity}
      onKeyDown={onActivity}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-8 sm:px-10">{children}</div>
    </div>
  );
}
