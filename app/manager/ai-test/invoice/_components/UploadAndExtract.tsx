"use client";

import { useState, type ChangeEvent } from "react";
import { extractInvoiceFromUpload, type ExtractInvoiceActionResult } from "@/app/actions/aiInvoiceExtraction";

const COMPARISON_MODEL = "gemini-3.6-flash";

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
          {result ? <ExtractionPanel title="Extraction" result={result} /> : null}
          {compareResult ? <ExtractionPanel title={`Comparison (${COMPARISON_MODEL})`} result={compareResult} /> : null}
        </div>
      </div>
    </div>
  );
}

function ExtractionPanel({ title, result }: { title: string; result: ExtractInvoiceActionResult }) {
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

  const { normalized, issues, model } = result.result;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title} ({model})
      </h3>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        <Field label="Vendor" value={normalized.vendorName} />
        <Field label="Invoice #" value={normalized.invoiceNumber} />
        <Field label="Invoice Date" value={normalized.invoiceDate} />
        <Field label="PO #" value={normalized.purchaseOrderNumber} />
        <Field label="Subtotal" value={formatMoney(normalized.subtotal)} />
        <Field label="Tax" value={formatMoney(normalized.tax)} />
        <Field label="Fees" value={formatMoney(normalized.fees)} />
        <Field label="Total" value={formatMoney(normalized.total)} />
      </dl>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-2 py-1">SKU</th>
              <th className="px-2 py-1">Description</th>
              <th className="px-2 py-1">Pkg Qty</th>
              <th className="px-2 py-1">Pkg Unit</th>
              <th className="px-2 py-1">Measured Qty</th>
              <th className="px-2 py-1">Measured Unit</th>
              <th className="px-2 py-1">Unit Price</th>
              <th className="px-2 py-1">Price Basis</th>
              <th className="px-2 py-1">Line Total</th>
            </tr>
          </thead>
          <tbody>
            {normalized.lines.map((line, index) => (
              <tr key={index} className="border-t border-zinc-800 text-zinc-200">
                <td className="px-2 py-1">{line.vendorSku ?? "—"}</td>
                <td className="px-2 py-1">{line.description ?? "—"}</td>
                <td className="px-2 py-1">{line.packageQuantity ?? "—"}</td>
                <td className="px-2 py-1">{line.packageUnit ?? "—"}</td>
                <td className="px-2 py-1">{line.measuredQuantity ?? "—"}</td>
                <td className="px-2 py-1">{line.measuredUnit ?? "—"}</td>
                <td className="px-2 py-1">{line.unitPrice ?? "—"}</td>
                <td className="px-2 py-1">{line.priceBasisUnit ?? "—"}</td>
                <td className="px-2 py-1">{line.lineTotal ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {normalized.warnings.length > 0 ? (
        <div className="mt-4">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Gemini warnings</h4>
          <ul className="flex flex-col gap-0.5 text-xs text-zinc-400">
            {normalized.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-400">Review flags</h4>
        {issues.length === 0 ? (
          <p className="text-xs text-emerald-400">None.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {issues.map((issue, index) => (
              <li
                key={index}
                className={
                  issue.severity === "error" ? "text-red-300" : issue.severity === "warning" ? "text-amber-300" : "text-zinc-400"
                }
              >
                [{issue.severity}] {issue.code}
                {issue.field ? ` (${issue.field})` : ""}: {issue.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatMoney(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={value ? "text-zinc-100" : "text-red-400"}>{value ?? "missing"}</dd>
    </>
  );
}
