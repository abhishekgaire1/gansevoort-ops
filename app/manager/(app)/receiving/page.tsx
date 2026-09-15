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
import type { PurchaseDocumentType } from "@/app/lib/purchaseDocuments/types";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { EmptyState } from "@/app/components/manager/EmptyState";
import {
  RECEIVING_TABS,
  RECEIVING_TAB_STATUSES,
  receivingStatusPresentation,
  viewerRelationshipFor,
  type ReceivingTabKey,
} from "./_lib/receivingPresentation";

/**
 * The manager receiving work queue -- a document/extraction/
 * purchase-document queue, not yet physical receiving/inventory posting
 * (that starts in a later milestone). Statuses are always derived (see
 * documentStatus.ts); nothing here is stored redundantly. Filters, tab,
 * AND page number are all URL state rendered by a plain server
 * component -- no client JS for filtering or paging, Next.js re-renders
 * from searchParams. The active tab's status SET (Part 8) is pushed
 * into search_receiving_queue itself -- applied BEFORE its limit
 * alongside every other filter -- and the list is numbered-page
 * paginated (QUEUE_PAGE_SIZE rows per page, Previous/Next + page links
 * + "Showing X-Y of Z", 20260811100151). The tab remains composed with
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

  const requestedPageRaw = Number(firstValue(params.page) ?? "1");
  const requestedPage = Number.isFinite(requestedPageRaw) && requestedPageRaw >= 1 ? Math.floor(requestedPageRaw) : 1;

  const [queuePage, uploaders, vendorsResult, activeCaptureResult] = await Promise.all([
    getReceivingQueuePage(auth.manager.organizationId, filters, RECEIVING_TAB_STATUSES[tab], requestedPage),
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
  // Changing any filter, tab, or search resets to page one -- the page
  // number never propagates through tab links or filter-chip removals
  // (and the GET form drops it naturally, since only form fields
  // submit).
  urlParams.delete("page");
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

      <div className="mt-6 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
        {queuePage.items.length === 0 ? (
          <div className="p-1">
            <EmptyState
              message="No documents match these filters."
              action={
                <Link href="/manager/receiving" className="text-xs text-amber-400 underline">
                  Clear Filters
                </Link>
              }
            />
          </div>
        ) : (
          queuePage.items.map((item) => {
            const href = item.purchaseDocumentId ? `/manager/purchases/${item.purchaseDocumentId}` : `/manager/receiving/${item.documentId}`;
            const viewer = viewerRelationshipFor(item.createdByAppUserId, auth.manager.appUserId);
            const presentation = receivingStatusPresentation(item.status, viewer, item.postingStatus);
            return (
              <Link key={item.documentId} href={href} className="flex items-center justify-between gap-4 px-4 py-4 hover:bg-zinc-800/50">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold text-zinc-100">{item.vendorName ?? item.originalFilename}</p>
                    {item.documentType ? <span className="shrink-0 text-xs text-zinc-500">{item.documentType}</span> : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {item.documentNumber ? `#${item.documentNumber} · ` : ""}
                    {item.documentDate ? `${item.documentDate} · ` : ""}
                    Uploaded by {item.uploadedByName} on {new Date(item.createdAt).toLocaleDateString()}
                    {item.verifiedByName ? ` · Verified by ${item.verifiedByName}` : ""}
                    {item.verificationMethod === "SOLE_APPROVER" ? " · Single-manager approval" : ""}
                  </p>
                  {/* Status Language -- Verification: viewer-relative context
                      line, never a fabricated "sent at" time (the queue's own
                      createdAt is the ORIGINAL upload time, not the later
                      submit time -- shown truthfully as "Uploaded by" above). */}
                  {item.status === "READY_FOR_VERIFICATION" && viewer === "preparer" ? (
                    <p className="mt-0.5 text-xs text-zinc-500">Waiting for another manager to verify.</p>
                  ) : null}
                  {item.status === "READY_FOR_VERIFICATION" && viewer === "eligible_verifier" && item.createdByName ? (
                    <p className="mt-0.5 text-xs text-zinc-500">Prepared by {item.createdByName}</p>
                  ) : null}
                  {item.originalVendorName || item.originalDocumentType ? (
                    <p className="mt-0.5 truncate text-xs text-amber-500">
                      Originally selected: {item.originalVendorName ?? ""}
                      {item.originalVendorName && item.originalDocumentType ? " · " : ""}
                      {item.originalDocumentType ?? ""}
                    </p>
                  ) : null}
                </div>
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <StatusBadge
                    label={
                      item.isAmendmentInProgress
                        ? `Amendment ${presentation.label} · Rev ${item.revisionNumber}`
                        : !item.isAmendmentInProgress && item.status === "VERIFIED" && item.revisionNumber && item.revisionNumber > 1
                          ? `${presentation.label} · Rev ${item.revisionNumber} · Current`
                          : presentation.label
                    }
                    tone={presentation.tone}
                  />
                  {item.isAmendmentInProgress && item.currentVerifiedRevisionNumber ? (
                    <span className="text-[10px] text-zinc-500">Current verified: Rev {item.currentVerifiedRevisionNumber}</span>
                  ) : null}
                  {presentation.actionLabel ? <span className="text-xs font-medium text-amber-400">{presentation.actionLabel}</span> : null}
                </span>
              </Link>
            );
          })
        )}
      </div>

      <PaginationBar page={queuePage.page} pageCount={queuePage.pageCount} pageSize={queuePage.pageSize} totalCount={queuePage.totalCount} baseParams={urlParams} />
    </div>
  );
}

/** Which page numbers to render as links: always first and last, a
 * window around the current page, with a single ellipsis marker (0)
 * covering each collapsed run. Pure so the windowing is unit-testable
 * mentally; e.g. 10 pages at page 5 -> 1 … 4 5 6 … 10. */
function pageNumbersToShow(page: number, pageCount: number): number[] {
  const wanted = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const pages = [...wanted].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  const withGaps: number[] = [];
  for (let i = 0; i < pages.length; i += 1) {
    if (i > 0 && pages[i] - pages[i - 1] > 1) withGaps.push(0);
    withGaps.push(pages[i]);
  }
  return withGaps;
}

function PaginationBar({
  page,
  pageCount,
  pageSize,
  totalCount,
  baseParams,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  totalCount: number;
  baseParams: URLSearchParams;
}) {
  if (totalCount === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);
  const hrefFor = (target: number) => withParam(baseParams, "page", target === 1 ? undefined : String(target));

  const pageLinkClass = "rounded-lg border border-zinc-700 px-2.5 py-1 text-xs hover:bg-zinc-800";
  const disabledClass = "rounded-lg border border-zinc-800 px-2.5 py-1 text-xs text-zinc-600";

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-zinc-500">
        Showing {from}–{to} of {totalCount} document{totalCount === 1 ? "" : "s"}
      </p>
      {pageCount > 1 ? (
        <nav aria-label="Pagination" className="flex items-center gap-1.5 text-zinc-300">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className={pageLinkClass}>
              ← Previous
            </Link>
          ) : (
            <span className={disabledClass}>← Previous</span>
          )}
          {pageNumbersToShow(page, pageCount).map((n, index) =>
            n === 0 ? (
              <span key={`gap-${index}`} className="px-1 text-xs text-zinc-600">
                …
              </span>
            ) : n === page ? (
              <span key={n} aria-current="page" className="rounded-lg border border-amber-500/60 bg-amber-950/30 px-2.5 py-1 text-xs font-semibold text-amber-300">
                {n}
              </span>
            ) : (
              <Link key={n} href={hrefFor(n)} className={pageLinkClass}>
                {n}
              </Link>
            )
          )}
          {page < pageCount ? (
            <Link href={hrefFor(page + 1)} className={pageLinkClass}>
              Next →
            </Link>
          ) : (
            <span className={disabledClass}>Next →</span>
          )}
        </nav>
      ) : null}
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
