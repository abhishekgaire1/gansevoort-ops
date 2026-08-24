/**
 * Thin browser client for the local Gansevoort Scanner Bridge (Direct
 * Scanner Intake milestone) -- talks to 127.0.0.1 over plain fetch(),
 * NOT to the Next.js server. Deliberately has zero dependency on
 * Supabase/server actions: this module only knows how to reach the
 * local helper and hand back either a job status or a downloaded PDF
 * Blob. Converging that Blob into a real document is the CALLER's job
 * (see ScanInvoiceFlow.tsx), reusing the exact same
 * initiateUpload/uploadAndFinalize pipeline a manually-picked file
 * already goes through.
 *
 * The bridge session token is held in a module-level variable (memory
 * only, never localStorage) -- short-lived by design (Part "BROWSER <->
 * BRIDGE AUTHENTICATION"), re-paired every time the Scan Invoice flow is
 * opened rather than persisted across page loads.
 */

const BRIDGE_BASE_URL = process.env.NEXT_PUBLIC_SCANNER_BRIDGE_URL ?? "http://127.0.0.1:8765";

export type ScannerStatus = "READY" | "BUSY" | "OFFLINE";

export interface BridgeScannerDevice {
  id: string;
  name: string;
  status: ScannerStatus;
  adfAvailable: boolean;
}

export type ScanJobState = "STARTING" | "SCANNING" | "PROCESSING" | "PAGES_READY" | "FINALIZING" | "DONE" | "FAILED" | "CANCELLED";

export type ScanErrorCode =
  | "NO_DOCUMENT_LOADED"
  | "PAPER_JAM"
  | "SCANNER_BUSY"
  | "SCANNER_OFFLINE"
  | "DEVICE_ERROR"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

export interface ScanJobPage {
  index: number;
  thumbnailDataUri: string;
}

export interface ScanJobStatus {
  id: string;
  state: ScanJobState;
  progressMessage: string | null;
  pageCount: number | null;
  pages: ScanJobPage[] | null;
  errorCode: ScanErrorCode | null;
  errorMessage: string | null;
}

export interface FinalizePageInstruction {
  sourceIndex: number;
  rotationDegrees: number;
}

async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BRIDGE_BASE_URL}${path}`, init);
}

/** Health check + implicit "is the bridge reachable at all" probe --
 * never throws, always resolves to a definite ok/not-ok so the UI can
 * show "Scanner Not Connected" instead of an unhandled rejection. */
export async function checkBridgeHealth(): Promise<{ ok: true; scannerCount: number } | { ok: false }> {
  try {
    const response = await bridgeFetch("/health");
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { scannerCount: number };
    return { ok: true, scannerCount: body.scannerCount };
  } catch {
    return { ok: false };
  }
}

export async function pairWithBridge(): Promise<{ ok: true; sessionToken: string } | { ok: false }> {
  try {
    const response = await bridgeFetch("/pair", { method: "POST" });
    if (!response.ok) return { ok: false };
    const body = (await response.json()) as { sessionToken: string };
    return { ok: true, sessionToken: body.sessionToken };
  } catch {
    return { ok: false };
  }
}

function authHeaders(sessionToken: string): HeadersInit {
  return { Authorization: `Bearer ${sessionToken}` };
}

export async function listBridgeScanners(sessionToken: string): Promise<BridgeScannerDevice[] | null> {
  try {
    const response = await bridgeFetch("/scanners", { headers: authHeaders(sessionToken) });
    if (!response.ok) return null;
    const body = (await response.json()) as { scanners: BridgeScannerDevice[] };
    return body.scanners;
  } catch {
    return null;
  }
}

export async function startBridgeScan(sessionToken: string, scannerId: string): Promise<{ jobId: string } | null> {
  try {
    const response = await bridgeFetch("/scan", {
      method: "POST",
      headers: { ...authHeaders(sessionToken), "Content-Type": "application/json" },
      body: JSON.stringify({ scannerId }),
    });
    if (!response.ok) return null;
    return (await response.json()) as { jobId: string };
  } catch {
    return null;
  }
}

export async function pollBridgeJob(sessionToken: string, jobId: string): Promise<ScanJobStatus | null> {
  try {
    const response = await bridgeFetch(`/jobs/${jobId}`, { headers: authHeaders(sessionToken) });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<ScanJobStatus> & { id: string; state: ScanJobState };
    return {
      id: body.id,
      state: body.state,
      progressMessage: body.progressMessage ?? null,
      pageCount: body.pageCount ?? null,
      pages: body.pages ?? null,
      errorCode: body.errorCode ?? null,
      errorMessage: body.errorMessage ?? null,
    };
  } catch {
    return null;
  }
}

export async function cancelBridgeJob(sessionToken: string, jobId: string): Promise<void> {
  try {
    await bridgeFetch(`/jobs/${jobId}/cancel`, { method: "POST", headers: authHeaders(sessionToken) });
  } catch {
    // Best-effort -- the periodic expiry sweep on the bridge cleans up
    // regardless if this particular request never lands.
  }
}

export async function finalizeBridgeJob(
  sessionToken: string,
  jobId: string,
  pages: FinalizePageInstruction[]
): Promise<{ ok: true } | { ok: false; errorCode?: ScanErrorCode; message?: string }> {
  try {
    const response = await bridgeFetch(`/jobs/${jobId}/finalize`, {
      method: "POST",
      headers: { ...authHeaders(sessionToken), "Content-Type": "application/json" },
      body: JSON.stringify({ pages }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: ScanErrorCode; message?: string } | null;
      return { ok: false, errorCode: body?.error, message: body?.message };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Downloads the finalized PDF as a Blob, ready to wrap in a File and
 * feed into the existing upload pipeline. The bridge deletes its own
 * copy immediately after serving this -- this download is the ONLY
 * chance to retrieve it. */
export async function downloadBridgeResult(sessionToken: string, jobId: string): Promise<Blob | null> {
  try {
    const response = await bridgeFetch(`/jobs/${jobId}/result`, { headers: authHeaders(sessionToken) });
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}
