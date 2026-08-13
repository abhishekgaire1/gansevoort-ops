import { notFound } from "next/navigation";
import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import type { PurchaseDocumentDiff, FieldChange, LineChange } from "@/app/lib/purchaseDocuments/types";

export const dynamic = "force-dynamic";

interface CorrectionEvent {
  id: string;
  actorAppUserId: string;
  actorName: string;
  occurredAt: string;
  diff: PurchaseDocumentDiff;
}

interface Cycle {
  submissionEventId: string;
  submittedAt: string;
  corrections: CorrectionEvent[];
  returned: { actorName: string; reason: string | null; occurredAt: string } | null;
  isSuccessfulCycle: boolean;
}

const FIELD_LABEL: Record<string, string> = {
  vendor_id: "Vendor",
  document_type: "Document type",
  document_number: "Document number",
  document_date: "Document date",
  po_number: "PO number",
  delivery_date: "Delivery date",
  subtotal: "Subtotal",
  tax: "Tax",
  fees: "Fees",
  total: "Total",
  currency: "Currency",
  vendor_sku: "SKU",
  description: "Description",
  package_quantity: "Package quantity",
  package_unit: "Package unit",
  measured_quantity: "Measured quantity",
  measured_unit: "Measured unit",
  unit_price: "Unit price",
  price_basis_unit: "Price basis",
  line_total: "Line total",
};

function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export default async function PurchaseDocumentChangesPage({ params }: { params: Promise<{ purchaseDocumentId: string }> }) {
  const { purchaseDocumentId } = await params;
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const serviceClient = getServiceRoleClient();

  const { data: purchaseDocument } = await serviceClient
    .from("purchase_documents")
    .select("id, vendor_id, document_number, revision_number")
    .eq("id", purchaseDocumentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (!purchaseDocument) {
    notFound();
  }

  const { data: events } = await serviceClient
    .from("audit_events")
    .select("id, action, actor_app_user_id, after_state, occurred_at")
    .eq("entity_type", "purchase_document")
    .eq("entity_id", purchaseDocumentId)
    .in("action", ["PURCHASE_DOCUMENT_SUBMITTED", "PURCHASE_DOCUMENT_REVIEW_CORRECTED", "PURCHASE_DOCUMENT_RETURNED", "PURCHASE_DOCUMENT_VERIFIED"])
    .order("occurred_at", { ascending: true });

  const rows = events ?? [];

  const appUserIds = new Set(rows.map((r) => r.actor_app_user_id as string));
  const { data: appUserRows } =
    appUserIds.size > 0
      ? await serviceClient.from("app_users").select("id, employees(first_name, last_name)").in("id", Array.from(appUserIds))
      : { data: [] };
  const nameByAppUserId = new Map<string, string>();
  for (const row of appUserRows ?? []) {
    const employee = Array.isArray(row.employees) ? row.employees[0] : row.employees;
    nameByAppUserId.set(row.id as string, employee ? `${employee.first_name} ${employee.last_name}` : "Unknown");
  }

  const submittedEvents = rows.filter((r) => r.action === "PURCHASE_DOCUMENT_SUBMITTED");
  const correctedEvents = rows.filter((r) => r.action === "PURCHASE_DOCUMENT_REVIEW_CORRECTED");
  const returnedEvents = rows.filter((r) => r.action === "PURCHASE_DOCUMENT_RETURNED");
  const verifiedEvent = rows.filter((r) => r.action === "PURCHASE_DOCUMENT_VERIFIED").slice(-1)[0];
  const successfulSubmissionId = (verifiedEvent?.after_state as { submissionAuditEventId?: string } | undefined)?.submissionAuditEventId ?? null;

  const cycles: Cycle[] = submittedEvents.map((submitted, index) => {
    const corrections = correctedEvents
      .filter((c) => (c.after_state as { submissionAuditEventId?: string })?.submissionAuditEventId === submitted.id)
      .map((c) => ({
        id: c.id as string,
        actorAppUserId: c.actor_app_user_id as string,
        actorName: nameByAppUserId.get(c.actor_app_user_id as string) ?? "Unknown",
        occurredAt: c.occurred_at as string,
        diff: c.after_state as PurchaseDocumentDiff,
      }));

    // The RETURNED event immediately following this submission (before the
    // next one, if any) is the one that rejected THIS cycle.
    const nextSubmitted = submittedEvents[index + 1];
    const returned = returnedEvents.find(
      (r) =>
        (r.occurred_at as string) > (submitted.occurred_at as string) &&
        (!nextSubmitted || (r.occurred_at as string) < (nextSubmitted.occurred_at as string))
    );

    return {
      submissionEventId: submitted.id as string,
      submittedAt: submitted.occurred_at as string,
      corrections,
      returned: returned
        ? { actorName: nameByAppUserId.get(returned.actor_app_user_id as string) ?? "Unknown", reason: (returned.after_state as { reason?: string })?.reason ?? null, occurredAt: returned.occurred_at as string }
        : null,
      isSuccessfulCycle: submitted.id === successfulSubmissionId,
    };
  });

  const successfulCycle = cycles.find((c) => c.isSuccessfulCycle) ?? null;
  const previousCycles = cycles.filter((c) => !c.isSuccessfulCycle);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={`/manager/purchases/${purchaseDocumentId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
        ← Back to Document
      </Link>
      <h1 className="text-xl font-semibold">Changes {purchaseDocument.document_number ? `for #${purchaseDocument.document_number}` : ""}</h1>

      {successfulCycle ? (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Corrections During Verification</h2>
          {successfulCycle.corrections.length === 0 ? (
            <p className="text-sm text-emerald-400">No corrections were made -- verified exactly as submitted.</p>
          ) : (
            <div className="flex flex-col gap-4">
              {successfulCycle.corrections.map((event) => (
                <CorrectionEventCard key={event.id} event={event} />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {previousCycles.length > 0 ? (
        <details className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Previous Review Attempts ({previousCycles.length})
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            {previousCycles.map((cycle) => (
              <div key={cycle.submissionEventId} className="rounded-xl border border-zinc-800 p-3">
                <p className="text-xs text-amber-400">
                  {cycle.returned ? (
                    <>
                      Returned by {cycle.returned.actorName} on {new Date(cycle.returned.occurredAt).toLocaleString()}
                      {cycle.returned.reason ? `: ${cycle.returned.reason}` : ""}
                    </>
                  ) : (
                    "Submitted, then superseded by a later resubmission"
                  )}
                  {" -- these corrections were reverted, not incorporated into the final verified truth."}
                </p>
                {cycle.corrections.length === 0 ? (
                  <p className="mt-2 text-xs text-zinc-500">No corrections were made during this attempt.</p>
                ) : (
                  <div className="mt-3 flex flex-col gap-3">
                    {cycle.corrections.map((event) => (
                      <CorrectionEventCard key={event.id} event={event} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {!successfulCycle && previousCycles.length === 0 ? <p className="mt-6 text-sm text-zinc-500">No submission history found.</p> : null}
    </div>
  );
}

function CorrectionEventCard({ event }: { event: CorrectionEvent }) {
  return (
    <div className="rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-col gap-2 text-sm">
        {event.diff.headerChanges.map((change, index) => (
          <FieldChangeRow key={`h-${index}`} change={change} />
        ))}
        {event.diff.lineChanges.map((change, index) => (
          <LineChangeRow key={`l-${index}`} change={change} />
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Corrected by {event.actorName} · {new Date(event.occurredAt).toLocaleString()}
      </p>
    </div>
  );
}

function FieldChangeRow({ change }: { change: FieldChange }) {
  return (
    <div>
      <p className="text-xs text-zinc-500">{fieldLabel(change.field)}</p>
      <p className="text-zinc-100">
        {displayValue(change.before)} <span className="text-zinc-500">→</span> {displayValue(change.after)}
      </p>
    </div>
  );
}

function LineChangeRow({ change }: { change: LineChange }) {
  if (change.kind === "added") {
    return (
      <div>
        <p className="text-xs text-emerald-400">Line added</p>
        <p className="text-zinc-100">{displayValue(change.line.description)}</p>
      </div>
    );
  }
  if (change.kind === "removed") {
    return (
      <div>
        <p className="text-xs text-red-400">Line removed</p>
        <p className="text-zinc-400 line-through">{displayValue(change.line.description)}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {change.fields.map((field, index) => (
        <FieldChangeRow key={index} change={field} />
      ))}
    </div>
  );
}
