"use client";

/**
 * Opens a new tab SYNCHRONOUSLY, on the same call stack as the triggering
 * click/tap, then points it at a URL that isn't known until an async
 * server call resolves (a signed document URL, in this app's case).
 *
 * Mobile Safari (iPad -- this app's primary device) revokes a tap's "user
 * activation" the moment an `await` crosses a task/microtask boundary, so
 * calling `window.open(url)` AFTER an awaited fetch is frequently blocked
 * silently by the popup blocker -- there is no error event, the tap just
 * appears to do nothing. Opening a blank tab first (still inside the
 * click handler's synchronous portion) and navigating THAT tab once the
 * real URL is known keeps the whole thing inside one user gesture.
 */
export function openPendingTab(): Window | null {
  return window.open("", "_blank", "noopener,noreferrer");
}

/** Navigates the tab opened by openPendingTab() once the real URL is
 * known. Falls back to a direct window.open() if the synchronous open
 * itself was blocked (rare) -- strictly no worse than the previous
 * behavior in that case. */
export function resolvePendingTab(tab: Window | null, url: string): void {
  if (tab && !tab.closed) {
    tab.location.href = url;
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** Closes the placeholder tab when the async call failed -- otherwise the
 * manager is left staring at a permanently blank tab with no content and
 * no way to know why. */
export function closePendingTab(tab: Window | null): void {
  if (tab && !tab.closed) tab.close();
}
