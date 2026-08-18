import type { NormalizedInvoiceExtraction, ReviewFlag } from "@/app/lib/ai/tasks/invoiceExtraction/types";
import { formatMoney } from "@/app/lib/formatMoney";

/**
 * Shared between the dev AI test harness and the real document detail page
 * -- both ultimately have exactly this shape available (a live extraction
 * result, or a persisted document_extractions row's normalized_extraction/
 * review_flags/model columns), so this takes only the shape itself, never
 * a Server Action result type or anything upload-flow-specific.
 */
export function ExtractionPanel({
  title,
  normalized,
  issues,
  model,
}: {
  title: string;
  normalized: NormalizedInvoiceExtraction;
  issues: ReviewFlag[];
  model: string;
}) {
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
        <Field label="Subtotal" value={normalized.subtotal !== null ? formatMoney(normalized.subtotal, normalized.currency) : null} />
        <Field label="Tax" value={normalized.tax !== null ? formatMoney(normalized.tax, normalized.currency) : null} />
        <Field label="Fees" value={normalized.fees !== null ? formatMoney(normalized.fees, normalized.currency) : null} />
        <Field label="Total" value={normalized.total !== null ? formatMoney(normalized.total, normalized.currency) : null} />
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
                <td className="px-2 py-1">{formatMoney(line.unitPrice, normalized.currency)}</td>
                <td className="px-2 py-1">{line.priceBasisUnit ?? "—"}</td>
                <td className="px-2 py-1">{formatMoney(line.lineTotal, normalized.currency)}</td>
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

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-zinc-500">{label}</dt>
      <dd className={value ? "text-zinc-100" : "text-red-400"}>{value ?? "missing"}</dd>
    </>
  );
}
