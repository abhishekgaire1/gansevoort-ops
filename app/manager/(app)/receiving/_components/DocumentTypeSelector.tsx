"use client";

import type { DeclaredDocumentType } from "@/app/actions/documentUpload";

/** The exact, existing canonical declared_document_type values
 * (documents_declared_document_type_check, 20260811100024) -- never
 * widened here. There is deliberately no "Other" option: the backend has
 * no matching enum value, and this control must never send one it does. */
export const DOCUMENT_TYPE_OPTIONS: { value: DeclaredDocumentType; label: string }[] = [
  { value: "INVOICE", label: "Invoice" },
  { value: "RECEIPT", label: "Receipt" },
  { value: "CREDIT_MEMO", label: "Credit Memo" },
];

/**
 * Compact segmented single-choice control for Document Type (Receiving
 * Upload/Intake Document Type milestone) -- a proper radio group under
 * the hood (native <input type="radio">, visually hidden but present for
 * keyboard/screen-reader use) styled as a row of small selectable
 * buttons rather than a native <select>. Shared by UploadDocumentForm and
 * ScanInvoiceFlow so both intake entry points stay visually and
 * behaviorally consistent.
 */
export function DocumentTypeSelector({
  name,
  value,
  onChange,
}: {
  name: string;
  value: DeclaredDocumentType;
  onChange: (value: DeclaredDocumentType) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
      <legend className="p-0 text-xs text-zinc-400">Document Type</legend>
      <div className="flex flex-wrap gap-2">
        {DOCUMENT_TYPE_OPTIONS.map((option) => {
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-amber-400/60 has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-zinc-900 ${
                checked
                  ? "border-amber-400 bg-amber-400/15 text-amber-100"
                  : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-600"
              }`}
            >
              <input type="radio" name={name} value={option.value} checked={checked} onChange={() => onChange(option.value)} className="sr-only" />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
