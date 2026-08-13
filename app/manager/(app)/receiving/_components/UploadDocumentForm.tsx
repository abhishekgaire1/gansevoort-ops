"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import {
  initiateDocumentUpload,
  finalizeDocumentUpload,
  type InitiateDocumentUploadResult,
  type DeclaredDocumentType,
} from "@/app/actions/documentUpload";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";
import type { VendorSummary } from "@/app/actions/vendors";

type InitiatedUpload = Extract<InitiateDocumentUploadResult, { ok: true }>;

const DOCUMENT_TYPE_OPTIONS: { value: DeclaredDocumentType; label: string }[] = [
  { value: "INVOICE", label: "Invoice" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "CREDIT_MEMO", label: "Credit Memo" },
];

async function sha256Hex(file: File): Promise<string | undefined> {
  try {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    // Only used for a non-blocking duplicate hint -- safe to skip.
    return undefined;
  }
}

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
  const [vendorId, setVendorId] = useState("");
  const [documentType, setDocumentType] = useState<DeclaredDocumentType | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ file: File; initiated: InitiatedUpload; uploadedAt: string } | null>(null);

  const canUpload = Boolean(vendorId) && Boolean(documentType);

  async function handleFile(file: File) {
    if (!vendorId || !documentType) return;
    setPending(true);
    setError(null);
    setDuplicate(null);

    const clientComputedSha256 = await sha256Hex(file);
    const initiated = await initiateDocumentUpload({
      filename: file.name,
      declaredContentType: file.type,
      vendorId,
      declaredDocumentType: documentType,
      clientComputedSha256,
    });

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

    const supabase = createBrowserClient(supabaseUrl, supabasePublishableKey);
    const { error: uploadError } = await supabase.storage
      .from(RECEIVING_DOCUMENTS_BUCKET)
      .uploadToSignedUrl(initiated.path, initiated.token, file);

    if (uploadError) {
      setPending(false);
      setError("Upload failed. Try again.");
      return;
    }

    const finalized = await finalizeDocumentUpload({
      documentId: initiated.documentId,
      declaredContentType: file.type,
      originalFilename: file.name,
      vendorId,
      declaredDocumentType: documentType,
    });

    setPending(false);

    if (!finalized.ok) {
      setError(finalized.message);
      return;
    }

    router.push(`/manager/receiving/${finalized.documentId}`);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <select
          value={vendorId}
          onChange={(event) => setVendorId(event.target.value)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
        >
          <option value="">Select vendor…</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </select>
        <select
          value={documentType}
          onChange={(event) => setDocumentType(event.target.value as DeclaredDocumentType)}
          className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
        >
          <option value="">Select type…</option>
          {DOCUMENT_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {vendors.length === 0 ? (
        <p className="text-xs text-amber-400">
          No active vendors yet.{" "}
          <a href="/manager/vendors" className="underline">
            Add one
          </a>{" "}
          before uploading.
        </p>
      ) : null}

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
        className="w-fit rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 transition disabled:opacity-40"
      >
        {pending ? "Uploading…" : "Upload Invoice / Take Photo"}
      </button>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {duplicate ? (
        <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
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
  );
}
