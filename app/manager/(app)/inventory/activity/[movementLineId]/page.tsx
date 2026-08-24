import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getInventoryActivityDetail } from "@/app/lib/inventory/globalActivity";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { actorLabelVerb, formatQuantityMagnitude, formatSignedQuantity, movementDisplayLabel, wasteReasonLabel } from "../../_lib/activityPresentation";

/**
 * Global Inventory Activity detail (Global Inventory Activity milestone,
 * Part 9) -- full available provenance for one movement line, by its own
 * id. Read-only: no correction action is offered here yet (see this
 * milestone's Phase D architecture proposal, delivered separately -- the
 * current movement model has no existing movement_type that honestly
 * represents a manager correction, so no write path was added). Technical
 * ids (movement/movement-line id) are deliberately never shown -- this
 * codebase has no existing subdued developer/audit section pattern to
 * reuse for that.
 */
export const dynamic = "force-dynamic";

function formatFullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

export default async function InventoryActivityDetailPage({ params }: { params: Promise<{ movementLineId: string }> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return null;
  }

  const { movementLineId } = await params;
  const detail = await getInventoryActivityDetail(getServiceRoleClient(), auth.manager.organizationId, movementLineId);

  if (!detail) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/inventory/activity" className={textLinkClass}>
          ← Inventory Activity
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Inventory activity not found.</p>
        </div>
      </div>
    );
  }

  const actorVerb = actorLabelVerb(detail.movementType);
  const itemHref = `/manager/inventory/items/${detail.inventoryItemId}?location=${detail.locationId}`;

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/manager/inventory/activity" className={textLinkClass}>
        ← Inventory Activity
      </Link>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">{movementDisplayLabel(detail.movementType)}</p>
      <Link href={itemHref} className="mt-1 block text-xl font-semibold text-zinc-100 hover:text-amber-300 hover:underline">
        {detail.itemName}
      </Link>

      <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <Row label="Quantity" value={formatSignedQuantity(detail.direction, detail.quantity, detail.baseUnitCode)} />

        {detail.movementType === "ISSUE_TO_STATION" ? (
          <>
            {detail.locationAttribution === "EXACT" ? <Row label="Source" value={detail.locationName} /> : null}
            {detail.station ? <Row label="Destination" value={detail.station.name} /> : null}
          </>
        ) : (
          <Row label="Location" value={detail.locationName} />
        )}

        {detail.vendor ? <Row label="Vendor" value={detail.vendor.name} /> : null}
        {detail.purchaseDocument ? (
          <Row
            label="Invoice"
            value={
              detail.purchaseDocument.documentNumber ? (
                <Link href={`/manager/purchases/${detail.purchaseDocument.id}`} className="text-amber-400 hover:underline">
                  #{detail.purchaseDocument.documentNumber} →
                </Link>
              ) : (
                <Link href={`/manager/purchases/${detail.purchaseDocument.id}`} className="text-amber-400 hover:underline">
                  View Document →
                </Link>
              )
            }
          />
        ) : null}

        {detail.waste ? <Row label="Reason" value={wasteReasonLabel(detail.waste.reasonCode)} /> : null}
        {detail.waste?.note ? <Row label="Note" value={detail.waste.note} /> : null}
        {detail.waste ? (
          <Row
            label="Source"
            value={
              <Link href={`/manager/inventory/waste/${detail.waste.id}`} className="text-amber-400 hover:underline">
                View Waste Details →
              </Link>
            }
          />
        ) : null}

        {detail.cycleCount ? <Row label="Expected" value={`${formatQuantityMagnitude(detail.cycleCount.expectedQuantity)} ${detail.baseUnitCode}`} /> : null}
        {detail.cycleCount ? <Row label="Counted" value={`${formatQuantityMagnitude(detail.cycleCount.countedQuantity)} ${detail.baseUnitCode}`} /> : null}
        {detail.cycleCount ? (
          <Row
            label="Source"
            value={
              <Link href={`/manager/inventory/cycle-count/${detail.cycleCount.id}`} className="text-amber-400 hover:underline">
                Cycle Count →
              </Link>
            }
          />
        ) : null}

        {actorVerb && detail.actor?.name ? <Row label={actorVerb} value={detail.actor.name} /> : null}
        <Row label="Time" value={formatFullTimestamp(detail.occurredAt)} />
      </div>

      {detail.movementType === "ISSUE_TO_STATION" && detail.locationAttribution === "LEGACY_ESTIMATED" ? (
        <p className="mt-3 text-xs text-zinc-600">Historical inventory record -- the exact source location predates source-aware tracking.</p>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-zinc-800 py-2 last:border-0">
      <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="text-sm font-medium text-zinc-100">{value}</span>
    </div>
  );
}
