"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createCaptureSessionAction,
  getCaptureSessionStatusAction,
  cancelCaptureSessionAction,
  getCaptureImageDownloadUrlAction,
  listCaptureSessionPagesAction,
  continueCaptureSessionAction,
  type CaptureSessionState,
} from "@/app/actions/invoiceCaptureDesktop";
import { addCapturedPageToDocumentAction } from "@/app/actions/invoiceCapturePageBridge";
import { createVendorFromReceiving, type VendorSummary } from "@/app/actions/vendors";
import type { DeclaredDocumentType } from "@/app/actions/documentUpload";
import { initiateUpload, uploadAndFinalize } from "../_lib/uploadFileToDocument";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { DocumentTypeSelector } from "./DocumentTypeSelector";

const POLL_INTERVAL_MS = 1500;

type Step = "closed" | "creating" | "waiting" | "received" | "uploading" | "expired" | "cancelled" | "error";

/**
 * Take Photo with Phone (Phone-to-Desktop Invoice Capture milestone).
 * Sits alongside Upload File in the Receiving toolbar (Part 3/51),
 * mirroring ScanInvoiceFlow.tsx's exact "local working state, then
 * converge into the EXISTING initiateUpload/uploadAndFinalize pipeline"
 * shape (Part 2/23) -- once a received photo is downloaded into a plain
 * File, everything from Continue onward is byte-for-byte the same code a
 * manually-picked file already runs through.
 *
 * Polling only, no Realtime (Phase A: no Realtime/websocket usage exists
 * anywhere in this project yet, and introducing one for a single feature
 * would be disproportionate -- Part 19-20 explicitly allow a polling
 * fallback to be the whole mechanism, provided the database stays the
 * source of truth, which it is here: every poll re-reads
 * get_invoice_capture_session_desktop, never trusts client-only state).
 */
export function TakePhotoWithPhoneFlow({
  supabaseUrl,
  supabasePublishableKey,
  vendors,
  initialActiveSession,
}: {
  supabaseUrl: string;
  supabasePublishableKey: string;
  vendors: VendorSummary[];
  initialActiveSession: CaptureSessionState | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(initialActiveSession ? mapInitialStep(initialActiveSession.status) : "closed");
  const [session, setSession] = useState<CaptureSessionState | null>(initialActiveSession);
  const [captureUrl, setCaptureUrl] = useState<string | null>(null);
  const [qrCodeDataUri, setQrCodeDataUri] = useState<string | null>(null);
  const [recoveredWithoutQr, setRecoveredWithoutQr] = useState(Boolean(initialActiveSession));
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [vendorList, setVendorList] = useState(vendors);
  const [vendorId, setVendorId] = useState("");
  const [documentType, setDocumentType] = useState<DeclaredDocumentType>("INVOICE");
  const [creatingVendor, setCreatingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [vendorCreatePending, setVendorCreatePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  useEffect(() => stopPolling, []);

  function loadPreview(sessionId: string) {
    getCaptureImageDownloadUrlAction(sessionId).then((result) => {
      if (result.ok) setPreviewUrl(result.downloadUrl);
    });
  }

  function beginPolling(sessionId: string) {
    stopPolling();
    pollTimer.current = setInterval(async () => {
      const result = await getCaptureSessionStatusAction(sessionId);
      if (!result.ok || !result.session) return;
      applySessionUpdate(result.session);
    }, POLL_INTERVAL_MS);
  }

  function applySessionUpdate(next: CaptureSessionState) {
    setSession(next);
    if (next.status === "WAITING") return; // no state change, keep polling
    stopPolling();
    if (next.status === "RECEIVED") {
      setStep("received");
      loadPreview(next.sessionId);
      return;
    }
    if (next.status === "EXPIRED") {
      setStep("expired");
      return;
    }
    if (next.status === "CANCELLED") {
      setStep("cancelled");
      return;
    }
    // CONTINUED -- another tab already finished this session (Part 28).
    if (next.status === "CONTINUED") {
      setStep("closed");
    }
  }

  // Refresh-recovery entry point (Part 27): resume polling/preview for a
  // session restored from the server on page load. The original QR
  // cannot be regenerated (the raw token is never persisted, by design --
  // Part 7), so a recovered WAITING session shows status only, with the
  // option to cancel and start fresh if the phone never actually scanned it.
  useEffect(() => {
    if (!initialActiveSession) return;
    if (initialActiveSession.status === "WAITING") {
      beginPolling(initialActiveSession.sessionId);
    } else if (initialActiveSession.status === "RECEIVED") {
      loadPreview(initialActiveSession.sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpen() {
    setStep("creating");
    setError(null);
    setRecoveredWithoutQr(false);
    const result = await createCaptureSessionAction();
    if (!result.ok) {
      setError("message" in result ? result.message : "Could not start a phone capture session.");
      setStep("error");
      return;
    }
    setSession(result.session);
    setCaptureUrl(result.captureUrl);
    setQrCodeDataUri(result.qrCodeDataUri);
    setStep("waiting");
    beginPolling(result.session.sessionId);
  }

  async function handleCancel() {
    stopPolling();
    if (session) await cancelCaptureSessionAction(session.sessionId);
    resetAll();
  }

  function resetAll() {
    stopPolling();
    setStep("closed");
    setSession(null);
    setCaptureUrl(null);
    setQrCodeDataUri(null);
    setRecoveredWithoutQr(false);
    setPreviewUrl(null);
    setVendorId("");
    setDocumentType("INVOICE");
    setError(null);
  }

  async function handleRetakeWithPhone() {
    // Invalidate the current session and start a brand new one -- never
    // silently retains the rejected image as the authoritative source
    // (Part 24).
    if (session) await cancelCaptureSessionAction(session.sessionId);
    setPreviewUrl(null);
    await handleOpen();
  }

  async function handleCreateVendor() {
    if (!newVendorName.trim()) return;
    setVendorCreatePending(true);
    const result = await createVendorFromReceiving(newVendorName.trim());
    setVendorCreatePending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setVendorList((list) => [...list, result.vendor].sort((a, b) => a.name.localeCompare(b.name)));
    setVendorId(result.vendor.id);
    setCreatingVendor(false);
    setNewVendorName("");
  }

  async function handleContinue() {
    if (!session || !previewUrl || !vendorId) return;
    setStep("uploading");
    setError(null);

    try {
      const response = await fetch(previewUrl);
      if (!response.ok) throw new Error("download_failed");
      const blob = await response.blob();
      const file = new File([blob], "phone-capture.jpg", { type: blob.type || "image/jpeg" });

      const initiated = await initiateUpload(file, vendorId, documentType);
      if (!initiated.ok) {
        setError(initiated.message);
        setStep("received");
        return;
      }
      if (initiated.possibleDuplicate) {
        setError("This looks like a duplicate of a document already uploaded. Check the queue before continuing.");
        setStep("received");
        return;
      }

      const finalized = await uploadAndFinalize(file, initiated, vendorId, documentType, supabaseUrl, supabasePublishableKey);
      if (!finalized.ok) {
        setError(finalized.message);
        setStep("received");
        return;
      }

      // Multi-page (100127): page 1 is now a real document via the normal
      // pipeline above -- every additional captured page (if any) is added
      // to that SAME document next, in order, never as a separate
      // document. Sequential, not parallel: add_document_page requires
      // each page to arrive in strict order.
      const pagesResult = await listCaptureSessionPagesAction(session.sessionId);
      if (pagesResult.ok) {
        const additionalPages = pagesResult.pages.filter((p) => p.pageNumber > 1).sort((a, b) => a.pageNumber - b.pageNumber);
        for (const page of additionalPages) {
          const pageResult = await addCapturedPageToDocumentAction(session.sessionId, finalized.documentId, page.pageNumber);
          if (!pageResult.ok) {
            setError(`Page ${page.pageNumber} could not be added: ${pageResult.message}`);
            setStep("received");
            return;
          }
        }
      }

      await continueCaptureSessionAction(session.sessionId, finalized.documentId);

      router.push(`/manager/receiving/${finalized.documentId}`);
      router.refresh();
    } catch {
      setError("Could not finish processing the photo. Try again.");
      setStep("received");
    }
  }

  const canClose = step !== "uploading" && step !== "creating";

  return (
    <>
      <button type="button" onClick={handleOpen} className={secondaryButtonClass}>
        + Take Photo with Phone
      </button>

      {step === "closed" ? null : (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Take Photo with Phone</h2>
              <button type="button" disabled={!canClose} onClick={handleCancel} aria-label="Close" className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40">
                ✕
              </button>
            </div>

            {step === "creating" ? <p className="mt-4 text-sm text-zinc-500">Starting…</p> : null}

            {step === "waiting" ? (
              <div className="mt-4 flex flex-col items-center gap-3 text-center">
                {qrCodeDataUri ? (
                  <>
                    <p className="text-sm text-zinc-400">Scan this code with the phone you want to use for the invoice photo.</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qrCodeDataUri} alt={`QR code linking to ${captureUrl}`} className="h-56 w-56 rounded-xl bg-white p-2" />
                    <p className="text-xs text-zinc-600">
                      Can&apos;t scan? Open <span className="text-zinc-400">{captureUrl}</span>
                    </p>
                  </>
                ) : recoveredWithoutQr ? (
                  <p className="text-sm text-zinc-400">
                    A capture is still waiting for a photo. If you haven&apos;t scanned the code yet, cancel and generate a new one.
                  </p>
                ) : null}
                <p className="text-sm font-medium text-zinc-300">Waiting for photo…</p>
                <p className="text-xs text-zinc-600">This code expires in 10 minutes.</p>
                <button type="button" onClick={handleCancel} className={secondaryButtonClass}>
                  Cancel
                </button>
              </div>
            ) : null}

            {step === "received" ? (
              <div className="mt-4 flex flex-col gap-3">
                <p className="text-sm font-semibold text-emerald-400">Photo Received</p>
                {previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewUrl} alt="Received invoice photo" className="w-full rounded-xl border border-zinc-800 object-contain" />
                ) : (
                  <p className="text-sm text-zinc-500">Loading preview…</p>
                )}
                <p className="text-xs text-zinc-500">
                  Source: Phone Capture · {session?.pageCount ?? 1} page{(session?.pageCount ?? 1) === 1 ? "" : "s"}
                </p>

                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  Vendor
                  <select value={vendorId} onChange={(e) => setVendorId(e.target.value)} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50">
                    <option value="">Select vendor…</option>
                    {vendorList.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                </label>
                <DocumentTypeSelector name="capture-document-type" value={documentType} onChange={setDocumentType} />

                {creatingVendor ? (
                  <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-3">
                    <label className="flex flex-col gap-1 text-xs text-zinc-400">
                      New Vendor Name
                      <input value={newVendorName} onChange={(e) => setNewVendorName(e.target.value)} autoFocus className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-50" />
                    </label>
                    <div className="mt-2 flex gap-3">
                      <button type="button" disabled={vendorCreatePending || !newVendorName.trim()} onClick={handleCreateVendor} className="rounded-full bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40">
                        {vendorCreatePending ? "Creating…" : "Create & Use Vendor"}
                      </button>
                      <button type="button" onClick={() => setCreatingVendor(false)} className="text-xs text-zinc-500 hover:text-zinc-300">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => setCreatingVendor(true)} className="self-start text-xs text-amber-300 hover:text-amber-200">
                    Vendor not listed? + Create New Vendor
                  </button>
                )}

                {error ? <p className="text-sm text-red-400">{error}</p> : null}

                <div className="mt-2 flex gap-3">
                  <button type="button" onClick={handleRetakeWithPhone} className={secondaryButtonClass}>
                    Retake with Phone
                  </button>
                  <button type="button" disabled={!vendorId} onClick={handleContinue} className={`flex-1 ${primaryButtonClass}`}>
                    Continue →
                  </button>
                </div>
              </div>
            ) : null}

            {step === "uploading" ? <p className="mt-4 text-sm text-zinc-400">Preparing invoice…</p> : null}

            {step === "expired" ? (
              <div className="mt-4 flex flex-col items-center gap-3 text-center">
                <p className="text-sm font-semibold text-zinc-100">Capture session expired.</p>
                <button type="button" onClick={handleOpen} className={primaryButtonClass}>
                  Generate New QR
                </button>
              </div>
            ) : null}

            {step === "cancelled" ? (
              <div className="mt-4 flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-zinc-400">Capture session cancelled.</p>
                <button type="button" onClick={resetAll} className={secondaryButtonClass}>
                  Close
                </button>
              </div>
            ) : null}

            {step === "error" ? (
              <div className="mt-4 flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-red-400">{error ?? "Something went wrong."}</p>
                <button type="button" onClick={handleOpen} className={primaryButtonClass}>
                  Try Again
                </button>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}

function mapInitialStep(status: CaptureSessionState["status"]): Step {
  if (status === "WAITING") return "waiting";
  if (status === "RECEIVED") return "received";
  if (status === "EXPIRED") return "expired";
  if (status === "CANCELLED") return "cancelled";
  return "closed";
}
