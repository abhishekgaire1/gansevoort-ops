import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { getHighWithdrawalAlertAction } from "@/app/actions/inventoryAlerts";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";

export const dynamic = "force-dynamic";

function formatOccurredAt(iso: string, timeZone: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString(undefined, { timeZone, dateStyle: "full", timeStyle: "short" });
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-sm text-zinc-100">{value}</span>
    </div>
  );
}

/**
 * A single HIGH_WITHDRAWAL alert, by exception id -- read-only (Section
 * 4C). A cross-organization or nonexistent exceptionId resolves to
 * `alert: null` (getHighWithdrawalAlertAction is org-scoped by
 * construction), rendered here as a not-found state, never another
 * organization's data and never a distinguishing error.
 */
export default async function InventoryAlertDetailPage({ params }: { params: Promise<{ exceptionId: string }> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    throw new Error("Not authorized to view this page.");
  }

  const { exceptionId } = await params;
  const [timeZone, alertResult] = await Promise.all([
    resolveOrganizationTimezone(getServiceRoleClient(), auth.manager.organizationId),
    getHighWithdrawalAlertAction(exceptionId),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="High Withdrawal Alert" backHref="/manager/inventory/alerts" backLabel="← Inventory Alerts" />

      {!alertResult.ok ? (
        <div className="mt-6">
          <EmptyState message={alertResult.message} />
        </div>
      ) : !alertResult.alert ? (
        <div className="mt-6">
          <EmptyState message="This alert was not found." />
        </div>
      ) : (
        <div className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
          <p className="text-lg font-semibold text-zinc-100">{alertResult.alert.itemName}</p>
          <p className="mt-1 text-sm text-amber-400">
            {alertResult.alert.observedQuantity} {alertResult.alert.unitCode} withdrawn — threshold {alertResult.alert.thresholdQuantity} {alertResult.alert.unitCode}
          </p>

          <div className="mt-4 divide-y divide-zinc-800">
            <Fact label="Date/Time" value={formatOccurredAt(alertResult.alert.occurredAt, timeZone)} />
            <Fact label="Item" value={alertResult.alert.itemName} />
            <Fact label="Station" value={alertResult.alert.stationName} />
            <Fact label="Employee" value={alertResult.alert.employeeName} />
            <Fact label="Withdrawn Quantity" value={`${alertResult.alert.observedQuantity} ${alertResult.alert.unitCode}`} />
            <Fact label="Configured Threshold" value={`${alertResult.alert.thresholdQuantity} ${alertResult.alert.unitCode}`} />
            <Fact label="Storage Location" value={alertResult.alert.sourceLocationName ?? "—"} />
            <Fact label="Status" value={alertResult.alert.status} />
          </div>

          <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
            <p className="text-xs text-zinc-400">
              This withdrawal was completed. The alert was created because the quantity exceeded the configured threshold.
            </p>
          </div>

          <p className="mt-4 text-xs text-zinc-600">
            <Link href={`/manager/inventory/items/${alertResult.alert.itemId}`} className="underline hover:text-zinc-400">
              View item history →
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
