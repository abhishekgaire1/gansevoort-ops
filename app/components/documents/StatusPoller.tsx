"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 2500;

/**
 * Renders nothing -- purely a side-effect component so mounting it
 * anywhere in a page's tree never affects layout. While `active` is true,
 * calls router.refresh() (a lightweight Next.js-native re-fetch of the
 * page's Server Components, preserving client component state -- no
 * WebSockets/Realtime/extra queue) on a fixed interval so a document stuck
 * on "Processing" picks up a completed/failed extraction without a manual
 * browser refresh. The interval is created/cleared by this effect alone:
 * `active` flipping to false (the caller re-deriving a terminal or stale
 * status from fresh server data) or the component unmounting both clear it
 * immediately -- there is no separate timeout/backoff to manage.
 */
export function StatusPoller({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;

    const intervalId = setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [active, router]);

  return null;
}
