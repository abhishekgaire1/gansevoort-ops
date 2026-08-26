import { afterEach, describe, expect, it, vi } from "vitest";
import { openPendingTab, resolvePendingTab, closePendingTab } from "@/app/lib/browser/pendingTab";

// CI-safe: `window` is stubbed directly (this suite runs in vitest's
// "node" environment, no jsdom) -- these functions only ever touch
// window.open/.location/.closed/.close(), never real DOM.

function fakeWindowOpen() {
  return vi.fn(() => ({ closed: false, location: { href: "" } }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openPendingTab", () => {
  it("opens a blank tab synchronously via window.open('', '_blank', ...)", () => {
    const open = fakeWindowOpen();
    vi.stubGlobal("window", { open });
    openPendingTab();
    expect(open).toHaveBeenCalledWith("", "_blank", "noopener,noreferrer");
  });
});

describe("resolvePendingTab", () => {
  it("navigates the already-open tab to the real URL once it's known", () => {
    const tab = { closed: false, location: { href: "" } };
    vi.stubGlobal("window", { open: vi.fn() });
    resolvePendingTab(tab as unknown as Window, "https://example.com/signed-url");
    expect(tab.location.href).toBe("https://example.com/signed-url");
  });

  it("falls back to a direct window.open() if the synchronous open was itself blocked", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    resolvePendingTab(null, "https://example.com/signed-url");
    expect(open).toHaveBeenCalledWith("https://example.com/signed-url", "_blank", "noopener,noreferrer");
  });

  it("falls back if the tab was already closed by the time the URL resolved", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const closedTab = { closed: true, location: { href: "" } };
    resolvePendingTab(closedTab as unknown as Window, "https://example.com/signed-url");
    expect(open).toHaveBeenCalledWith("https://example.com/signed-url", "_blank", "noopener,noreferrer");
  });
});

describe("closePendingTab", () => {
  it("closes an open tab", () => {
    const close = vi.fn();
    const tab = { closed: false, close };
    closePendingTab(tab as unknown as Window);
    expect(close).toHaveBeenCalled();
  });

  it("does nothing for a null tab or an already-closed one", () => {
    expect(() => closePendingTab(null)).not.toThrow();
    const close = vi.fn();
    closePendingTab({ closed: true, close } as unknown as Window);
    expect(close).not.toHaveBeenCalled();
  });
});
