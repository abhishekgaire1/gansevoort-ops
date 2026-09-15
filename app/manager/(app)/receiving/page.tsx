import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getReceivingQueuePage, listReceivingQueueUploaders, type ReceivingQueueFilters } from "@/app/lib/documents/receivingQueue";
import type { ReceivingItemStatus } from "@/app/lib/documents/documentStatus";
import { shouldPollForStatuses } from "@/app/lib/documents/pollingDecision";
import { StatusPoller } from "@/app/components/documents/StatusPoller";
import { listVendors } from "@/app/actions/vendors";
import { getActiveCaptureSessionAction } from "@/app/actions/invoiceCaptureDesktop";
import { UploadDocumentForm } from "./_components/UploadDocumentForm";
import { TakePhotoWithPhoneFlow } from "./_components/TakePhotoWithPhoneFlow";
import { ReceivingQueueList } from "./_components/ReceivingQueueList";
import type { PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { RECEIVING_TABS, RECEIVING_TAB_STATUSES, receivingStatusPresentation, type ReceivingTabKey } from "./_lib/receivingPresentation";

/**
 * The manager receiving work queue -- a document/extraction/
 * purchase-document queue, not yet physical receiving/inventory posting
 * (that starts in a later milestone). Statuses are always derived (see
 * documentStatus.ts); nothing here is stored redundantly. Filters are a
 * plain server-rendered GET form -- no client JS needed for filtering
 * itself, Next.js re-renders this Server Component from the URL's
 * searchParams. Since the pagination pass, the active tab's status SET
 * (Part 8) is pushed into search_receiving_queue itself -- applied
 * BEFORE its limit alongside every other filter -- and the page fetches
 * only the first QUEUE_PAGE_SIZE rows; older pages append client-side
 * via ReceivingQueueList's Load More. The tab remains composed with
 * (not a replacement for) the precise "Status" filter under More
 * Filters.
 */
export const dynamic = "force-dynamic";

const DOCUMENT_TYPE_OPTIONS: PurchaseDocumentType[] = ["INVOICE", "RECEIPT", "CREDIT_MEMO"];

function firstValue(value: string | string[] | undefined): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved ? resolved : undefined;
}

function withParam(params: URLSearchParams, key: string, value: string | undefined): string {
  const next = new URLSearchParams(params);
  if (value === undefined || value === "") {
    next.delete(key);
  } else {
    next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `/manager/receiving?${qs}` : "/manager/receiving";
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
  const tab = (["ALL", "NEEDS_ATTENTION", "READY_FOR_VERIFICATION", "VERIFIED"] as const).includes(
    firstValue(params.tab) as ReceivingTabKey
  )
    ? (firstValue(params.tab) as ReceivingTabKey)
    : "ALL";
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

  const [queuePage, uploaders, vendorsResult, activeCaptureResult] = await Promise.all([
    getReceivingQueuePage(auth.manager.organizationId, filters, RECEIVING_TAB_STATUSES[tab]),
    listReceivingQueueUploaders(auth.manager.organizationId),
    listVendors(),
    getActiveCaptureSessionAction(),
  ]);
  const vendors = vendorsResult.ok ? vendorsResult.vendors : [];
  const initialActiveCaptureSession = activeCaptureResult.ok ? activeCaptureResult.session : null;
  // Extraction-status polling watches the FIRST page only -- PROCESSING/
  // STALLED documents are by definition recent uploads, and the queue is
  // newest-first, so anything still extracting is on page one.
  const statuses = queuePage.items.map((item) => item.status);

  const uploaderOptions = uploaders.map((u) => [u.appUserId, u.name] as [string, string]);

  const urlParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const resolved = firstValue(value);
    if (resolved) urlParams.set(key, resolved);
  }
  const paramsWithoutTab = new URLSearchParams(urlParams);
  paramsWithoutTab.delete("tab");

  const activeFilterChips: { label: string; removeHref: string }[] = [];
  const vendorName = vendors.find((v) => v.id === filters.vendorId)?.name;
  if (vendorName) activeFilterChips.push({ label: vendorName, removeHref: withParam(urlParams, "vendor", undefined) });
  if (filters.status) {
    activeFilterChips.push({ label: receivingStatusPresentation(filters.status).label, removeHref: withParam(urlParams, "status", undefined) });
  }
  if (filters.documentType) activeFilterChips.push({ label: filters.documentType, removeHref: withParam(urlParams, "documentType", undefined) });
  const uploaderName = uploaderOptions.find(([id]) => id === filters.uploadedByAppUserId)?.[1];
  if (uploaderName) activeFilterChips.push({ label: `Uploaded by ${uploaderName}`, removeHref: withParam(urlParams, "uploadedBy", undefined) });
  if (filters.dateFrom || filters.dateTo) {
    const rangeParams = new URLSearchParams(urlParams);
    rangeParams.delete("dateFrom");
    rangeParams.delete("dateTo");
    const qs = rangeParams.toString();
    activeFilterChips.push({
      label: `${filters.dateFrom ?? "…"} – ${filters.dateTo ?? "…"}`,
      removeHref: qs ? `/manager/receiving?${qs}` : "/manager/receiving",
    });
  }

  return (
    <div className="mx-auto max-w-6xl">
      <StatusPoller active={shouldPollForStatuses(statuses)} />
      <PageHeader
        title="Receiving Queue"
        description="Invoices moving through review and verification."
        action={
          // Receiving UX pass, Part 6: scanner intake stays paused --
          // ScanInvoiceFlow itself is untouched/preserved, just not wired
          // into this page. Take Photo with Phone (Phone-to-Desktop
          // Invoice Capture milestone) is a genuinely new, separate
          // source method, not a resumption of that paused work.
          <div className="flex flex-wrap gap-2">
            <UploadDocumentForm supabaseUrl={supabaseUrl} supabasePublishableKey={supabasePublishableKey} vendors={vendors} />
            <TakePhotoWithPhoneFlow
              supabaseUrl={supabaseUrl}
              supabasePublishableKey={supabasePublishableKey}
              vendors={vendors}
              initialActiveSession={initialActiveCaptureSession}
            />
          </div>
        }
      />

      <div className="mt-5 flex flex-wrap items-center gap-1.5">
        {RECEIVING_TABS.map((t) => (
          <Link
            key={t.key}
            href={withParam(paramsWithoutTab, "tab", t.key === "ALL" ? undefined : t.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
              tab === t.key ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <form method="get" className="mt-4 flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-3">
        <input type="hidden" name="tab" value={tab === "ALL" ? "" : tab} />
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Search
          <input
            type="text"
            name="q"
            defaultValue={filters.q}
            placeholder="Search invoices…"
            className="w-48 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-50"
          />
        </label>
        <FilterSelect name="vendor" label="Vendor" defaultValue={filters.vendorId} options={vendors.map((v) => ({ value: v.id, label: v.name }))} />
        <FilterSelect
          name="documentType"
          label="Type"
          defaultValue={filters.documentType}
          options={DOCUMENT_TYPE_OPTIONS.map((value) => ({ value, label: value }))}
        />
        <details className="group">
          <summary className="cursor-pointer list-none rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">
            More Filters ▾
          </summary>
          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-3">
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
              // DISCARDED is deliberately excluded -- it's not a normal
              // status filter value in this milestone; discarded records
              // are hidden from the queue outright, not filterable.
              options={(["PROCESSING", "STALLED", "NEEDS_REVIEW", "FAILED", "DRAFT", "READY_FOR_VERIFICATION", "VERIFIED"] as const).map((value) => ({
                value,
                label: receivingStatusPresentation(value).label,
              }))}
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
              <input type="date" name="dateFrom" defaultValue={filters.dateFrom} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              To
              <input type="date" name="dateTo" defaultValue={filters.dateTo} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50" />
            </label>
          </div>
        </details>
        <button type="submit" className="rounded-full bg-zinc-100 px-4 py-1.5 text-xs font-semibold text-zinc-950">
          Apply
        </button>
        <Link href={tab === "ALL" ? "/manager/receiving" : `/manager/receiving?tab=${tab}`} className="text-xs text-zinc-500 underline">
          Clear Filters
        </Link>
      </form>
      {dateType === "business" ? (
        <p className="mt-2 text-xs text-zinc-500">
          Business Document Date only matches documents with a recorded (drafted or verified) business date, not the
          unverified extracted date.
        </p>
      ) : null}

      {activeFilterChips.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {activeFilterChips.map((chip) => (
            <Link
              key={chip.label}
              href={chip.removeHref}
              className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              {chip.label} <span aria-hidden="true">×</span>
            </Link>
          ))}
        </div>
      ) : null}

      <ReceivingQueueList
        initialItems={queuePage.items}
        initialNextCursor={queuePage.nextCursor}
        filters={filters}
        tab={tab}
        currentAppUserId={auth.manager.appUserId}
      />
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
      <select name={name} defaultValue={defaultValue ?? ""} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-50">
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
