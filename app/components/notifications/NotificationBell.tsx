"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "@/app/actions/notifications";
import type { UserNotification } from "@/app/lib/notifications/types";

/** Minimal in-app bell/badge/dropdown -- no email/SMS/push. Polls the same
 * lightweight way StatusPoller already works for extraction status: a
 * plain interval while the dropdown could plausibly have new content,
 * no websockets/real-time infrastructure. */
const POLL_INTERVAL_MS = 30_000;

function entityHref(notification: UserNotification): string {
  if (notification.entityType === "purchase_document") {
    return `/manager/purchases/${notification.entityId}`;
  }
  return "#";
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<UserNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  async function refresh() {
    const result = await listNotifications();
    if (result.ok) {
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    }
  }

  useEffect(() => {
    // Deliberate fetch-on-mount + poll, same pattern as StatusPoller's
    // router.refresh() interval -- there's no props/state this could be
    // derived from during render, and no external store to subscribe to
    // via useSyncExternalStore; a plain interval is the simplest correct
    // tool here, same as the rest of this codebase's polling.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleOpen() {
    setOpen((prev) => !prev);
  }

  async function handleNotificationClick(notification: UserNotification) {
    if (!notification.readAt) {
      await markNotificationRead(notification.id);
      refresh();
    }
    setOpen(false);
  }

  async function handleMarkAllRead() {
    await markAllNotificationsRead();
    refresh();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="relative rounded-full p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
        aria-label="Notifications"
      >
        <BellIcon />
        {unreadCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-[10px] font-bold text-zinc-950">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-10 mt-2 w-80 rounded-2xl border border-zinc-800 bg-zinc-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Notifications</p>
            {unreadCount > 0 ? (
              <button type="button" onClick={handleMarkAllRead} className="text-xs text-amber-400 underline">
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-zinc-500">No notifications.</p>
            ) : (
              notifications.map((notification) => (
                <Link
                  key={notification.id}
                  href={entityHref(notification)}
                  onClick={() => handleNotificationClick(notification)}
                  className={`block border-b border-zinc-800 px-4 py-3 last:border-0 hover:bg-zinc-800/50 ${!notification.readAt ? "bg-zinc-800/30" : ""}`}
                >
                  <p className="text-sm font-medium text-zinc-100">{notification.title}</p>
                  {notification.body ? <p className="mt-0.5 text-xs text-zinc-400">{notification.body}</p> : null}
                  <p className="mt-1 text-[10px] text-zinc-500">{new Date(notification.createdAt).toLocaleString()}</p>
                </Link>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
