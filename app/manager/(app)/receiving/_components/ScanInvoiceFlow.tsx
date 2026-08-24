"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  checkBridgeHealth,
  pairWithBridge,
  listBridgeScanners,
  startBridgeScan,
  pollBridgeJob,
  cancelBridgeJob,
  finalizeBridgeJob,
  downloadBridgeResult,
  type BridgeScannerDevice,
  type ScanJobStatus,
} from "@/app/lib/scannerBridge/client";
import { initiateUpload, uploadAndFinalize } from "../_lib/uploadFileToDocument";
import {
  movePage as movePageIn,
  rotatePage as rotatePageIn,
  deletePage as deletePageIn,
  buildFinalizeInstructions,
  scanErrorMessage,
  type WorkingScanPage,
} from "../_lib/scanPreview";
import type { DeclaredDocumentType } from "@/app/actions/documentUpload";
import type { VendorSummary } from "@/app/actions/vendors";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { DocumentTypeSelector } from "./DocumentTypeSelector";

const LAST_SCANNER_STORAGE_KEY = "gansevoort-last-scanner-id";
const POLL_INTERVAL_MS = 400;

/** One captured page in the local review/edit working set -- purely
 * client-side state (Part "SCAN PREVIEW" / "DO NOT UPLOAD BEFORE MANAGER
 * ACCEPTS"). Array order IS display/final order; removing an entry is
 * "delete accidental page." Nothing here has touched Gansevoort Ops'
 * own upload pipeline yet. */
type WorkingPage = WorkingScanPage;

type FlowStep = "checking" | "unavailable" | "ready" | "scanning" | "preview" | "details" | "uploading";

/**
 * Scan Invoice (Direct Scanner Intake milestone): Receiving Queue -> local
 * scanner bridge -> Canon MF741Cdw ADF -> preview -> manager accepts ->
 * EXISTING invoice upload/document pipeline. Converges into the exact
 * same initiateUpload/uploadAndFinalize sequence UploadDocumentForm uses
 * (Part 14) -- everything before that point (bridge pairing, scanning,
 * preview/rotate/delete) is purely local/temporary and creates no
 * Gansevoort Ops record until "Process Invoice." Self-contained trigger
 * + modal, same shape as UploadDocumentForm, so the two sit side by side
 * in the Receiving Queue header with no shared parent state (Part 30:
 * "[ Scan Invoice ] [ Upload File ]").
 */
export function ScanInvoiceFlow({
  supabaseUrl,
  supabasePublishableKey,
  vendors,
}: {
  supabaseUrl: string;
  supabasePublishableKey: string;
  vendors: VendorSummary[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonClass}>
        + Scan Invoice
      </button>
      {open ? (
        <ScanInvoiceModal supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} vendors={vendors} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ScanInvoiceModal({
  supabaseUrl,
  supabasePublishableKey,
  vendors,
  onClose,
}: {
  supabaseUrl: string;
  supabasePublishableKey: string;
  vendors: VendorSummary[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<FlowStep>("checking");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [scanners, setScanners] = useState<BridgeScannerDevice[]>([]);
  const [selectedScannerId, setSelectedScannerId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState("Starting scanner…");
  const [pages, setPages] = useState<WorkingPage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [vendorId, setVendorId] = useState("");
  const [documentType, setDocumentType] = useState<DeclaredDocumentType>("INVOICE");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function connect() {
    setStep("checking");
    setError(null);
    const health = await checkBridgeHealth();
    if (!health.ok) {
      setStep("unavailable");
      return;
    }
    const paired = await pairWithBridge();
    if (!paired.ok) {
      setStep("unavailable");
      return;
    }
    setSessionToken(paired.sessionToken);
    const list = await listBridgeScanners(paired.sessionToken);
    if (!list) {
      setStep("unavailable");
      return;
    }
    setScanners(list);
    const remembered = typeof window !== "undefined" ? window.localStorage.getItem(LAST_SCANNER_STORAGE_KEY) : null;
    const preselected = list.find((s) => s.id === remembered) ?? list[0] ?? null;
    setSelectedScannerId(preselected?.id ?? null);
    setStep("ready");
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connect();
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function applyJobStatus(status: ScanJobStatus) {
    if (status.progressMessage) setProgressMessage(status.progressMessage);

    if (status.state === "PAGES_READY") {
      stopPolling();
      const capturedPages = status.pages ?? [];
      setPages(capturedPages.map((p) => ({ sourceIndex: p.index, thumbnailDataUri: p.thumbnailDataUri, rotationDegrees: 0 })));
      setStep("preview");
      return;
    }
    if (status.state === "FAILED") {
      stopPolling();
      setError(scanErrorMessage(status.errorCode));
      setStep("ready");
      return;
    }
    if (status.state === "CANCELLED") {
      stopPolling();
      setStep("ready");
    }
  }

  async function handleStartScan() {
    if (!sessionToken || !selectedScannerId) return;
    setError(null);
    setProgressMessage("Starting scanner…");
    const started = await startBridgeScan(sessionToken, selectedScannerId);
    if (!started) {
      setError("Could not start the scan. Try again.");
      return;
    }
    if (typeof window !== "undefined") window.localStorage.setItem(LAST_SCANNER_STORAGE_KEY, selectedScannerId);
    setJobId(started.jobId);
    setStep("scanning");

    pollTimer.current = setInterval(async () => {
      const status = await pollBridgeJob(sessionToken, started.jobId);
      if (status) applyJobStatus(status);
    }, POLL_INTERVAL_MS);
  }

  async function handleCancelScan() {
    stopPolling();
    if (sessionToken && jobId) await cancelBridgeJob(sessionToken, jobId);
    setJobId(null);
    setStep("ready");
  }

  async function handleRescan() {
    if (sessionToken && jobId) await cancelBridgeJob(sessionToken, jobId);
    setJobId(null);
    setPages([]);
    setStep("ready");
  }

  function rotatePage(index: number) {
    setPages((current) => rotatePageIn(current, index));
  }

  function deletePage(index: number) {
    setPages((current) => deletePageIn(current, index));
  }

  function movePage(index: number, direction: -1 | 1) {
    setPages((current) => movePageIn(current, index, direction));
  }

  async function handleProcessInvoice() {
    if (!sessionToken || !jobId || !vendorId || !documentType || pages.length === 0) return;
    setUploadError(null);
    setStep("uploading");

    const finalizeResult = await finalizeBridgeJob(
      sessionToken,
      jobId,
      buildFinalizeInstructions(pages)
    );
    if (!finalizeResult.ok) {
      setUploadError("Could not prepare the scanned pages. Try again.");
      setStep("details");
      return;
    }

    const blob = await downloadBridgeResult(sessionToken, jobId);
    if (!blob) {
      setUploadError("Could not retrieve the scanned invoice. Try again.");
      setStep("details");
      return;
    }

    const file = new File([blob], "scanned-invoice.pdf", { type: "application/pdf" });

    // From here down: the EXACT same pipeline a manually-picked file
    // uses (Part 14) -- file validation, hashing, private Storage,
    // finalize RPC, extraction scheduling.
    const initiated = await initiateUpload(file, vendorId, documentType);
    if (!initiated.ok) {
      setUploadError(initiated.message);
      setStep("details");
      return;
    }
    if (initiated.possibleDuplicate) {
      // A scanned duplicate is handled the same conservative way a
      // manual upload's would be -- surfaced as an error rather than a
      // silent second copy; the manager can open the existing document
      // from the queue.
      setUploadError("This looks like a duplicate of a document already uploaded. Check the queue before scanning again.");
      setStep("details");
      return;
    }

    const finalized = await uploadAndFinalize(file, initiated, vendorId, documentType, supabaseUrl, supabasePublishableKey);
    if (!finalized.ok) {
      setUploadError(finalized.message);
      setStep("details");
      return;
    }

    router.push(`/manager/receiving/${finalized.documentId}`);
    router.refresh();
  }

  const selectedScanner = scanners.find((s) => s.id === selectedScannerId) ?? null;
  const canClose = step !== "uploading" && step !== "scanning";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
        <div className="flex items-start justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Scan Invoice</h2>
          <button type="button" disabled={!canClose} onClick={onClose} aria-label="Close" className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40">
            ✕
          </button>
        </div>

        {step === "checking" ? <p className="mt-4 text-sm text-zinc-500">Looking for the scanner helper…</p> : null}

        {step === "unavailable" ? (
          <div className="mt-4">
            <p className="text-sm font-semibold text-zinc-100">Scanner Not Connected</p>
            <p className="mt-2 text-sm text-zinc-400">
              The Gansevoort Scanner helper could not be reached on this computer.
            </p>
            <div className="mt-4 flex gap-3">
              <button type="button" onClick={connect} className={primaryButtonClass}>
                Try Again
              </button>
              <button type="button" onClick={onClose} className={secondaryButtonClass}>
                Upload File Instead
              </button>
            </div>
          </div>
        ) : null}

        {step === "ready" ? (
          <div className="mt-4">
            {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Scanner
              <select
                value={selectedScannerId ?? ""}
                onChange={(e) => setSelectedScannerId(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              >
                {scanners.map((scanner) => (
                  <option key={scanner.id} value={scanner.id}>
                    {scanner.name}
                  </option>
                ))}
              </select>
            </label>
            {selectedScanner ? (
              <div className="mt-3 flex items-center gap-4 text-xs text-zinc-500">
                <span>
                  Status: <span className={selectedScanner.status === "READY" ? "text-emerald-400" : "text-amber-400"}>{formatStatus(selectedScanner.status)}</span>
                </span>
                <span>ADF: {selectedScanner.adfAvailable ? "Available" : "Not available"}</span>
              </div>
            ) : null}
            <p className="mt-4 text-sm text-zinc-400">Place one invoice in the document feeder.</p>
            <button
              type="button"
              disabled={!selectedScanner || selectedScanner.status !== "READY" || !selectedScanner.adfAvailable}
              onClick={handleStartScan}
              className={`mt-4 w-full ${primaryButtonClass}`}
            >
              Start Scan
            </button>
          </div>
        ) : null}

        {step === "scanning" ? (
          <div className="mt-4 flex flex-col items-center gap-3 py-6">
            <p className="text-sm text-zinc-300">{progressMessage}</p>
            <button type="button" onClick={handleCancelScan} className={secondaryButtonClass}>
              Cancel
            </button>
          </div>
        ) : null}

        {step === "preview" ? (
          <div className="mt-4">
            <p className="text-sm font-semibold text-zinc-100">Scan Complete</p>
            <p className="mt-1 text-xs text-zinc-500">
              {pages.length} {pages.length === 1 ? "page" : "pages"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {pages.map((page, index) => (
                <div key={`${page.sourceIndex}-${index}`} className="flex flex-col items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={page.thumbnailDataUri}
                    alt={`Page ${index + 1}`}
                    className="h-24 w-20 object-contain"
                    style={{ transform: `rotate(${page.rotationDegrees}deg)` }}
                  />
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => movePage(index, -1)} disabled={index === 0} aria-label="Move left" className="text-xs text-zinc-500 disabled:opacity-30">
                      ←
                    </button>
                    <button type="button" onClick={() => rotatePage(index)} aria-label="Rotate" className="text-xs text-zinc-400 hover:text-zinc-200">
                      ⟳
                    </button>
                    <button type="button" onClick={() => deletePage(index)} aria-label="Delete page" className="text-xs text-red-400 hover:text-red-300">
                      ✕
                    </button>
                    <button
                      type="button"
                      onClick={() => movePage(index, 1)}
                      disabled={index === pages.length - 1}
                      aria-label="Move right"
                      className="text-xs text-zinc-500 disabled:opacity-30"
                    >
                      →
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {pages.length === 0 ? <p className="mt-3 text-sm text-amber-400">All pages removed -- rescan to continue.</p> : null}
            <div className="mt-4 flex gap-3">
              <button type="button" onClick={handleRescan} className={secondaryButtonClass}>
                Rescan
              </button>
              <button type="button" disabled={pages.length === 0} onClick={() => setStep("details")} className={primaryButtonClass}>
                Use Scan →
              </button>
            </div>
          </div>
        ) : null}

        {step === "details" || step === "uploading" ? (
          <div className="mt-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Vendor
              <select
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
              >
                <option value="">Select vendor…</option>
                {vendors.map((vendor) => (
                  <option key={vendor.id} value={vendor.id}>
                    {vendor.name}
                  </option>
                ))}
              </select>
            </label>
            <DocumentTypeSelector name="scan-document-type" value={documentType} onChange={setDocumentType} />
            {uploadError ? <p className="text-sm text-red-400">{uploadError}</p> : null}
            <button
              type="button"
              disabled={step === "uploading" || !vendorId || !documentType}
              onClick={handleProcessInvoice}
              className={primaryButtonClass}
            >
              {step === "uploading" ? "Processing…" : "Process Invoice"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatStatus(status: BridgeScannerDevice["status"]): string {
  switch (status) {
    case "READY":
      return "Ready";
    case "BUSY":
      return "Busy";
    case "OFFLINE":
      return "Offline";
  }
}
