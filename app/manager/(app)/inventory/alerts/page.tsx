import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { listHighWithdrawalAlertsAction } from "@/app/actions/inventoryAlerts";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { EmptyState } from "@/app/components/manager/EmptyState";

export const dynamic = "force-dynamic";

function formatOccurredAt(iso: string, timeZone: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString(undefined, { timeZone, dateStyle: "medium", timeStyle: "short" });
}

/**
 * RC1 High-Withdrawal Manager Visibility -- Inventory Alerts (Section
 * 4B). Read-only, newest first. This is the only place a manager can
 * discover an existing HIGH_WITHDRAWAL exception -- detection itself
 * (20260811100076/100080) already worked before this page existed; only
 * visibility was missing.
 *
 * Deliberately informational, not an approval queue: every alert here
 * represents an ALREADY-COMPLETED withdrawal. There is nothing to
 * approve/acknowledge/resolve -- see app/actions/inventoryAlerts.ts's own
 * header comment for why (no established review lifecycle exists to
 * build on).
 */
export default async function InventoryAlertsPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    throw new Error("Not authorized to view this page.");
  }

  const [timeZone, alertsResult] = await Promise.all([
    resolveOrganizationTimezone(getServiceRoleClient(), auth.manager.organizationId),
    listHighWithdrawalAlertsAction(),
  ]);
  const alerts = alertsResult.ok ? alertsResult.alerts : null;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Inventory Alerts" description="High-withdrawal alerts -- informational only. Every withdrawal below has already completed normally." />

      {!alertsResult.ok ? (
        <div className="mt-6">
          <EmptyState message={alertsResult.message} />
        </div>
      ) : alerts && alerts.length === 0 ? (
        <div className="mt-6">
          <EmptyState message="No high-withdrawal alerts. Alerts appear here when a withdrawal exceeds its configured threshold." />
        </div>
      ) : (
        <div className="mt-6 flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
          {(alerts ?? []).map((alert) => (
            <Link key={alert.exceptionId} href={`/manager/inventory/alerts/${alert.exceptionId}`} className="flex flex-col gap-1 px-4 py-3 hover:bg-zinc-800/50 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100">{alert.itemName}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {alert.stationName} · {alert.employeeName} · {formatOccurredAt(alert.occurredAt, timeZone)}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium text-amber-400">
                  {alert.observedQuantity} {alert.unitCode}
                </p>
                <p className="text-[11px] text-zinc-500">threshold {alert.thresholdQuantity} {alert.unitCode}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
