import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getReceivingQueue, type ReceivingQueueFilters } from "@/app/lib/documents/receivingQueue";
import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";
import { shouldPollForStatuses } from "@/app/lib/documents/pollingDecision";
import { StatusPoller } from "@/app/components/documents/StatusPoller";
import { listVendors } from "@/app/actions/vendors";
import { UploadDocumentForm } from "./_components/UploadDocumentForm";
import type { PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";

/**
 * The first real manager receiving queue -- a document/extraction/
 * purchase-document queue, not yet physical receiving/inventory posting
 * (that starts in a later milestone). Statuses are always derived (see
 * documentStatus.ts); nothing here is stored redundantly. Filters are a
 * plain server-rendered GET form -- no client JS needed for filtering
 * itself, Next.js re-renders this Server Component from the URL's
 * searchParams.
 */
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ReceivingItemStatus, string> = {
  PROCESSING: "Processing",
  STALLED: "Extraction Stalled",
  NEEDS_REVIEW: "Needs Review",
  FAILED: "Extraction Failed",
  DRAFT: "Draft",
  READY_FOR_VERIFICATION: "Ready for Verification",
  VERIFIED: "Verified",
};

const STATUS_CLASS: Record<ReceivingItemStatus, string> = {
  PROCESSING: "text-zinc-400",
  STALLED: "text-amber-400",
  NEEDS_REVIEW: "text-emerald-400",
  FAILED: "text-red-400",
  DRAFT: "text-sky-400",
  READY_FOR_VERIFICATION: "text-amber-400",
  VERIFIED: "text-emerald-400",
};

const DOCUMENT_TYPE_OPTIONS: PurchaseDocumentType[] = ["INVOICE", "RECEIPT", "CREDIT_MEMO"];

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved ? resolved : undefined;
}

export default async function ReceivingQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    // The (app) layout above already redirects unauthenticated/unauthorized
    // requests before this ever renders; this is a defensive fallback only.
    return null;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error("SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set");
  }

  const params = await searchParams;
  const dateType = firstValue(params.dateType) === "business" ? "business" : "uploaded";
  const filters: ReceivingQueueFilters = {
    vendorId: firstValue(params.vendor),
    uploadedByAppUserId: firstValue(params.uploadedBy),
    status: firstValue(params.status) as ReceivingItemStatus | undefined,
    documentType: firstValue(params.documentType) as PurchaseDocumentType | undefined,
    dateFrom: firstValue(params.dateFrom),
    dateTo: firstValue(params.dateTo),
    dateType,
    q: firstValue(params.q),
  };

  const [queue, vendorsResult] = await Promise.all([getReceivingQueue(auth.manager.organizationId, filters), listVendors()]);
  const vendors = vendorsResult.ok ? vendorsResult.vendors : [];
  const statuses = queue.map((item) => item.status);

  const uploaderOptions = Array.from(
    new Map(queue.map((item) => [item.uploadedByAppUserId, item.uploadedByName])).entries()
  ).sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="mx-auto max-w-6xl">
      <StatusPoller active={shouldPollForStatuses(statuses)} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Receiving Queue</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Uploaded documents and their extraction/verification status. Not yet a physical receiving/posting workflow.
          </p>
        </div>
        <UploadDocumentForm supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} vendors={vendors} />
      </div>

      <form method="get" className="mt-6 flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <FilterSelect name="vendor" label="Vendor" defaultValue={filters.vendorId} options={vendors.map((v) => ({ value: v.id, label: v.name }))} />
        <FilterSelect
          name="uploadedBy"
          label="Uploaded By"
          defaultValue={filters.uploadedByAppUserId}
          options={uploaderOptions.map(([id, name]) => ({ value: id, label: name }))}
        />
        <FilterSelect
          name="status"
          label="Status"
          defaultValue={filters.status}
          options={Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))}
        />
        <FilterSelect
          name="documentType"
          label="Document Type"
          defaultValue={filters.documentType}
          options={DOCUMENT_TYPE_OPTIONS.map((value) => ({ value, label: value }))}
        />
        <FilterSelect
          name="dateType"
          label="Date Type"
          defaultValue={dateType}
          options={[
            { value: "uploaded", label: "Uploaded Date" },
            { value: "business", label: "Business Document Date" },
          ]}
        />
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          From
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          To
          <input type="date" name="dateTo" defaultValue={filters.dateTo} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Search
          <input
            type="text"
            name="q"
            defaultValue={filters.q}
            placeholder="Document # or filename"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50"
          />
        </label>
        <button type="submit" className="rounded-full bg-zinc-100 px-4 py-1.5 text-xs font-semibold text-zinc-950">
          Apply
        </button>
        <Link href="/manager/receiving" className="text-xs text-zinc-400 underline">
          Clear
        </Link>
      </form>
      {dateType === "business" ? (
        <p className="mt-2 text-xs text-zinc-500">
          Business Document Date only matches documents with a recorded (drafted or verified) business date -- not
          Gemini&apos;s unverified extracted date.
        </p>
      ) : null}

      <div className="mt-6 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {queue.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No documents match these filters.</p>
        ) : (
          queue.map((item) => {
            const href = item.purchaseDocumentId ? `/manager/purchases/${item.purchaseDocumentId}` : `/manager/receiving/${item.documentId}`;
            return (
              <Link key={item.documentId} href={href} className="flex items-center justify-between gap-4 px-4 py-4 hover:bg-zinc-800/50">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {item.vendorName ?? item.originalFilename}
                    {item.documentType ? <span className="ml-2 text-xs text-zinc-500">{item.documentType}</span> : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {item.documentNumber ? `#${item.documentNumber} · ` : ""}
                    {item.documentDate ? `${item.documentDate} · ` : ""}
                    Uploaded by {item.uploadedByName} on {new Date(item.createdAt).toLocaleDateString()}
                    {item.verifiedByName ? ` · Verified by ${item.verifiedByName}` : ""}
                  </p>
                  {item.originalVendorName || item.originalDocumentType ? (
                    <p className="mt-0.5 truncate text-xs text-amber-500">
                      Originally selected: {item.originalVendorName ?? ""}
                      {item.originalVendorName && item.originalDocumentType ? " · " : ""}
                      {item.originalDocumentType ?? ""}
                    </p>
                  ) : null}
                </div>
                <span className={`shrink-0 text-xs font-semibold uppercase tracking-wide ${STATUS_CLASS[item.status]}`}>
                  {STATUS_LABEL[item.status]}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <select name={name} defaultValue={defaultValue ?? ""} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-50">
        <option value="">All</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
