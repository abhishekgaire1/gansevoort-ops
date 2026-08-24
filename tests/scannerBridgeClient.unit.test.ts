import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBridgeHealth,
  pairWithBridge,
  listBridgeScanners,
  startBridgeScan,
  pollBridgeJob,
  cancelBridgeJob,
  finalizeBridgeJob,
  downloadBridgeResult,
} from "@/app/lib/scannerBridge/client";

/**
 * The browser-side scanner bridge client (Direct Scanner Intake
 * milestone) -- pure fetch() wrappers, tested here with a mocked
 * global.fetch so every scenario (bridge unavailable, scan start,
 * polling, cancel, finalize, download) runs without a real bridge
 * process or hardware (Part 32/40).
 */

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkBridgeHealth", () => {
  it("returns ok with scannerCount when the bridge responds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ bridgeVersion: "0.1.0", scannerSubsystemAvailable: true, scannerCount: 2 }))
    );
    const result = await checkBridgeHealth();
    expect(result).toEqual({ ok: true, scannerCount: 2 });
  });

  it("returns not-ok when the bridge is unreachable (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Failed to fetch");
      })
    );
    const result = await checkBridgeHealth();
    expect(result).toEqual({ ok: false });
  });

  it("returns not-ok on a non-200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 403)));
    const result = await checkBridgeHealth();
    expect(result).toEqual({ ok: false });
  });
});

describe("pairWithBridge", () => {
  it("returns a session token on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ sessionToken: "abc123", expiresInSeconds: 1800 })));
    const result = await pairWithBridge();
    expect(result).toEqual({ ok: true, sessionToken: "abc123" });
  });

  it("returns not-ok when pairing fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "origin_not_allowed" }, false, 403)));
    const result = await pairWithBridge();
    expect(result).toEqual({ ok: false });
  });
});

describe("listBridgeScanners", () => {
  it("returns the scanner list", async () => {
    const scanners = [{ id: "canon-1", name: "Canon MF741Cdw", status: "READY", adfAvailable: true }];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ scanners })));
    const result = await listBridgeScanners("token");
    expect(result).toEqual(scanners);
  });

  it("returns null on failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, false, 401)));
    const result = await listBridgeScanners("bad-token");
    expect(result).toBeNull();
  });

  it("sends the session token as a Bearer authorization header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ scanners: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await listBridgeScanners("my-token");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-token");
  });
});

describe("startBridgeScan", () => {
  it("returns the new jobId", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobId: "job-1" })));
    const result = await startBridgeScan("token", "canon-1");
    expect(result).toEqual({ jobId: "job-1" });
  });

  it("sends scannerId in the request body", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ jobId: "job-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await startBridgeScan("token", "canon-1");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ scannerId: "canon-1" });
  });

  it("returns null when the scanner is busy/offline (non-2xx)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "SCANNER_BUSY" }, false, 409)));
    const result = await startBridgeScan("token", "canon-1");
    expect(result).toBeNull();
  });
});

describe("pollBridgeJob", () => {
  it("reports SCANNING progress", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "job-1", state: "SCANNING", progressMessage: "Scanning page 2…" }))
    );
    const status = await pollBridgeJob("token", "job-1");
    expect(status?.state).toBe("SCANNING");
    expect(status?.progressMessage).toBe("Scanning page 2…");
  });

  it("reports PAGES_READY with page thumbnails once captured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "job-1",
          state: "PAGES_READY",
          pageCount: 5,
          pages: [{ index: 0, thumbnailDataUri: "data:image/jpeg;base64,AAA" }],
        })
      )
    );
    const status = await pollBridgeJob("token", "job-1");
    expect(status?.state).toBe("PAGES_READY");
    expect(status?.pageCount).toBe(5);
    expect(status?.pages).toHaveLength(1);
  });

  it("reports FAILED with a safe error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ id: "job-1", state: "FAILED", errorCode: "PAPER_JAM", errorMessage: "Paper jam in the document feeder." }))
    );
    const status = await pollBridgeJob("token", "job-1");
    expect(status?.state).toBe("FAILED");
    expect(status?.errorCode).toBe("PAPER_JAM");
  });

  it("returns null for an unknown job", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unknown_job" }, false, 404)));
    const status = await pollBridgeJob("token", "does-not-exist");
    expect(status).toBeNull();
  });
});

describe("cancelBridgeJob", () => {
  it("never throws, even if the bridge is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    await expect(cancelBridgeJob("token", "job-1")).resolves.toBeUndefined();
  });
});

describe("finalizeBridgeJob", () => {
  it("sends the page manifest and reports success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: "job-1", state: "DONE" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await finalizeBridgeJob("token", "job-1", [{ sourceIndex: 0, rotationDegrees: 90 }]);
    expect(result).toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ pages: [{ sourceIndex: 0, rotationDegrees: 90 }] });
  });

  it("surfaces a structured error on failure, never a raw exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "INTERNAL_ERROR", message: "Could not assemble the final PDF." }, false, 422)));
    const result = await finalizeBridgeJob("token", "job-1", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("INTERNAL_ERROR");
    }
  });
});

describe("downloadBridgeResult", () => {
  it("returns a Blob on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }) }) as unknown as Response)
    );
    const blob = await downloadBridgeResult("token", "job-1");
    expect(blob).toBeInstanceOf(Blob);
  });

  it("returns null when the result isn't ready yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "not_ready" }, false, 409)));
    const blob = await downloadBridgeResult("token", "job-1");
    expect(blob).toBeNull();
  });
});

describe("no server secrets referenced client-side", () => {
  it("the bridge client module source never mentions a Gansevoort server secret name", async () => {
    // A lightweight structural guard (Part 27: "The scanner helper must
    // NEVER contain SUPABASE_SECRET_KEY, service_role, GEMINI_API_KEY,
    // PIN_PEPPER, KIOSK_TOKEN_SECRET") -- this module is the browser's
    // OWN client for talking to the local bridge, so it's an equally
    // important place to guarantee never references any of these.
    const source = await import("node:fs/promises").then((fs) => fs.readFile("app/lib/scannerBridge/client.ts", "utf-8"));
    for (const forbidden of ["SUPABASE_SECRET_KEY", "service_role", "GEMINI_API_KEY", "PIN_PEPPER", "KIOSK_TOKEN_SECRET"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
