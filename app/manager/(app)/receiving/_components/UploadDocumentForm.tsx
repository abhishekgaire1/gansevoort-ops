"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { initiateDocumentUpload, finalizeDocumentUpload, type InitiateDocumentUploadResult } from "@/app/actions/documentUpload";
import { RECEIVING_DOCUMENTS_BUCKET } from "@/app/lib/documents/storageConstants";

type InitiatedUpload = Extract<InitiateDocumentUploadResult, { ok: true }>;

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

export function UploadDocumentForm({
  supabaseUrl,
  supabasePublishableKey,
}: {
  supabaseUrl: string;
  supabasePublishableKey: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ file: File; initiated: InitiatedUpload; uploadedAt: string } | null>(null);

  async function handleFile(file: File) {
    setPending(true);
    setError(null);
    setDuplicate(null);

    const clientComputedSha256 = await sha256Hex(file);
    const initiated = await initiateDocumentUpload({ filename: file.name, declaredContentType: file.type, clientComputedSha256 });

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
    <div className="flex flex-col gap-2">
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
        disabled={pending}
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
