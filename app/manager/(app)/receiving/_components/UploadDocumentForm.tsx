"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { DeclaredDocumentType } from "@/app/actions/documentUpload";
import { createVendorFromReceiving, type VendorSummary } from "@/app/actions/vendors";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { initiateUpload, uploadAndFinalize as sharedUploadAndFinalize, type InitiatedUpload } from "../_lib/uploadFileToDocument";
import { DocumentTypeSelector } from "./DocumentTypeSelector";

/**
 * Vendor-first + document-type-first intake (Milestone 2A.2): the manager
 * must declare both BEFORE the file picker is usable -- these become the
 * immutable documents.vendor_id / documents.declared_document_type facts,
 * re-validated server-side at both initiate and finalize.
 */
export function UploadDocumentForm({
  supabaseUrl,
  supabasePublishableKey,
  vendors,
}: {
  supabaseUrl: string;
  supabasePublishableKey: string;
  vendors: VendorSummary[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [vendorList, setVendorList] = useState(vendors);
  const [vendorId, setVendorId] = useState("");
  const [documentType, setDocumentType] = useState<DeclaredDocumentType>("INVOICE");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ file: File; initiated: InitiatedUpload; uploadedAt: string } | null>(null);
  const [creatingVendor, setCreatingVendor] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");
  const [vendorCreatePending, setVendorCreatePending] = useState(false);
  const [vendorCreateError, setVendorCreateError] = useState<string | null>(null);

  async function handleCreateVendor() {
    if (!newVendorName.trim()) return;
    setVendorCreatePending(true);
    setVendorCreateError(null);
    const result = await createVendorFromReceiving(newVendorName.trim());
    setVendorCreatePending(false);
    if (!result.ok) {
      setVendorCreateError(result.message);
      return;
    }
    setVendorList((list) => [...list, result.vendor].sort((a, b) => a.name.localeCompare(b.name)));
    setVendorId(result.vendor.id);
    setCreatingVendor(false);
    setNewVendorName("");
  }

  const canUpload = Boolean(vendorId) && Boolean(documentType);

  async function handleFile(file: File) {
    if (!vendorId || !documentType) return;
    setPending(true);
    setError(null);
    setDuplicate(null);

    const initiated = await initiateUpload(file, vendorId, documentType);

    if (!initiated.ok) {
      setPending(false);
      setError(initiated.message);
      return;
    }

    if (initiated.possibleDuplicate) {
      setPending(false);
      setDuplicate({ file, initiated, uploadedAt: initiated.possibleDuplicate.uploadedAt });
      return;
    }

    await uploadAndFinalize(file, initiated);
  }

  async function uploadAndFinalize(file: File, initiated: InitiatedUpload) {
    if (!documentType) return;
    setPending(true);
    setDuplicate(null);

    const finalized = await sharedUploadAndFinalize(file, initiated, vendorId, documentType, supabaseUrl, supabasePublishableKey);

    setPending(false);

    if (!finalized.ok) {
      setError(finalized.message);
      return;
    }

    router.push(`/manager/receiving/${finalized.documentId}`);
    router.refresh();
  }

  const canClose = !pending;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={secondaryButtonClass}>
        + Upload File
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Upload Invoice</h2>
              <button
                type="button"
                disabled={!canClose}
                onClick={() => {
                  setOpen(false);
                  setError(null);
                  setDuplicate(null);
                }}
                aria-label="Close"
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-xs text-zinc-500">Select the vendor and document type, then choose or photograph the invoice.</p>

            <div className="mt-4 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Vendor
                <select
                  value={vendorId}
                  onChange={(event) => setVendorId(event.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
                >
                  <option value="">Select vendor…</option>
                  {vendorList.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </option>
                  ))}
                </select>
              </label>
              <DocumentTypeSelector name="upload-document-type" value={documentType} onChange={setDocumentType} />
            </div>

            {/* Controlled Manager exception (Admin Master Data milestone,
                Part 15-17): a vendor not found among active vendors never
                stalls Receiving -- minimal name-only quick-create, right
                here, no Admin required. */}
            {creatingVendor ? (
              <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-950 p-3">
                <label className="flex flex-col gap-1 text-xs text-zinc-400">
                  New Vendor Name
                  <input
                    value={newVendorName}
                    onChange={(e) => setNewVendorName(e.target.value)}
                    autoFocus
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-50"
                  />
                </label>
                {vendorCreateError ? <p className="mt-2 text-xs text-red-400">{vendorCreateError}</p> : null}
                <div className="mt-2 flex gap-3">
                  <button
                    type="button"
                    disabled={vendorCreatePending || !newVendorName.trim()}
                    onClick={handleCreateVendor}
                    className="rounded-full bg-amber-400 px-3 py-1.5 text-xs font-semibold text-zinc-950 disabled:opacity-40"
                  >
                    {vendorCreatePending ? "Creating…" : "Create & Use Vendor"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreatingVendor(false);
                      setNewVendorName("");
                      setVendorCreateError(null);
                    }}
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setCreatingVendor(true)} className="mt-3 text-xs text-amber-300 hover:text-amber-200">
                {vendorList.length === 0 ? "No active vendors yet. + Create New Vendor" : "Vendor not listed? + Create New Vendor"}
              </button>
            )}

            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              capture="environment"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void handleFile(file);
              }}
            />
            <button
              type="button"
              disabled={pending || !canUpload}
              onClick={() => inputRef.current?.click()}
              className={`mt-4 w-full ${primaryButtonClass}`}
            >
              {pending ? "Uploading…" : "Upload Invoice / Take Photo"}
            </button>
            {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
            {duplicate ? (
              <div className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
                <p>Possible duplicate. This exact file was previously uploaded on {new Date(duplicate.uploadedAt).toLocaleString()}.</p>
                <div className="mt-2 flex gap-4">
                  <a href={`/manager/receiving/${duplicate.initiated.possibleDuplicate?.documentId}`} className="underline">
                    Open Existing
                  </a>
                  <button type="button" className="underline" onClick={() => void uploadAndFinalize(duplicate.file, duplicate.initiated)}>
                    Upload Anyway
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
