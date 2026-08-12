"use client";

import { useState, type ChangeEvent } from "react";
import { extractInvoiceFromUpload, type ExtractInvoiceActionResult } from "@/app/actions/aiInvoiceExtraction";
import { ExtractionPanel } from "@/app/components/invoiceExtraction/ExtractionPanel";

// gemini-3.6-flash is now the configured default (app/lib/ai/config.ts) --
// the comparison model here is the PREVIOUS default, kept for benchmarking
// the two against each other.
const COMPARISON_MODEL = "gemini-3.5-flash-lite";

export function UploadAndExtract() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [compareModel, setCompareModel] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ExtractInvoiceActionResult | null>(null);
  const [compareResult, setCompareResult] = useState<ExtractInvoiceActionResult | null>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setResult(null);
    setCompareResult(null);
    setPreviewUrl(selected && selected.type.startsWith("image/") ? URL.createObjectURL(selected) : null);
  }

  async function handleExtract() {
    if (!file || pending) return;
    setPending(true);
    setResult(null);
    setCompareResult(null);
    try {
      const primaryForm = new FormData();
      primaryForm.set("file", file);
      const primary = await extractInvoiceFromUpload(primaryForm);
      setResult(primary);

      if (compareModel) {
        const secondaryForm = new FormData();
        secondaryForm.set("file", file);
        const secondary = await extractInvoiceFromUpload(secondaryForm, COMPARISON_MODEL);
        setCompareResult(secondary);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <input
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          onChange={handleFileChange}
          className="text-sm text-zinc-300"
        />
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={compareModel} onChange={(event) => setCompareModel(event.target.checked)} />
          Also run {COMPARISON_MODEL} for comparison
        </label>
        <button
          type="button"
          onClick={handleExtract}
          disabled={!file || pending}
          className="rounded-full bg-amber-400 px-6 py-2 text-sm font-semibold text-zinc-950 transition disabled:opacity-40"
        >
          {pending ? "Extracting…" : "Extract with Gemini"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Document</h2>
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- transient client-side blob preview, not an optimizable static asset
            <img src={previewUrl} alt="Uploaded document preview" className="max-h-[70vh] w-full rounded-lg object-contain" />
          ) : file ? (
            <p className="text-sm text-zinc-400">
              {file.name} ({(file.size / 1024).toFixed(0)} KB) — PDF preview not rendered here; extraction still runs against the uploaded file.
            </p>
          ) : (
            <p className="text-sm text-zinc-500">No file selected yet.</p>
          )}
        </div>

        <div className="flex flex-col gap-6">
          {result ? <ResultPanel title="Extraction" result={result} /> : null}
          {compareResult ? <ResultPanel title={`Comparison (${COMPARISON_MODEL})`} result={compareResult} /> : null}
        </div>
      </div>
    </div>
  );
}

function ResultPanel({ title, result }: { title: string; result: ExtractInvoiceActionResult }) {
  if (!result.ok) {
    return (
      <div className="rounded-2xl border border-red-800 bg-red-950/40 p-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-300">{title} — failed</h3>
        <p className="text-sm text-red-200">
          [{result.reason}] {result.message}
        </p>
      </div>
    );
  }

  return <ExtractionPanel title={title} normalized={result.result.normalized} issues={result.result.issues} model={result.result.model} />;
}
