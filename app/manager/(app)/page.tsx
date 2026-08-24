import Link from "next/link";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getReceivingQueue } from "@/app/lib/documents/receivingQueue";
import { listCycleCountDraftStatus } from "@/app/actions/cycleCounts";
import { resolveEmployeeDisplayNames } from "@/app/lib/inventory/cycleCounts";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";
import { viewerRelationshipFor } from "@/app/manager/(app)/receiving/_lib/receivingPresentation";

/**
 * The manager landing page (Manager UX & Navigation Milestone, Part 11):
 * "what needs me right now," never analytics/reporting. Every "Needs
 * Your Attention" item is backed by a real, already-implemented query --
 * ready-for-verification count reuses the exact same getReceivingQueue
 * the Receiving Queue itself uses, and "cycle count in progress" reuses
 * listCycleCountDraftStatus filtered to counts THIS manager owns (the
 * only ones they can genuinely "Resume"). No variance-approval item is
 * shown -- that workflow does not exist yet anywhere in this codebase,
 * and Part 11 is explicit: never fake an attention item.
 */
export const dynamic = "force-dynamic";

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default async function ManagerDashboardPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) return null;

  const supabase = getServiceRoleClient();
  const [readyForVerification, draftsResult, names] = await Promise.all([
    getReceivingQueue(auth.manager.organizationId, { status: "READY_FOR_VERIFICATION" }),
    listCycleCountDraftStatus(),
    resolveEmployeeDisplayNames(supabase, [auth.manager.appUserId]),
  ]);

  const firstName = (names.get(auth.manager.appUserId) ?? "").split(" ")[0] || "there";
  const ownDrafts = draftsResult.ok ? draftsResult.drafts.filter((d) => d.isOwnedByCurrentManager) : [];

  // Status Language -- Verification: this count previously included the
  // manager's OWN submissions, offering "Review ->" on something they are
  // not allowed to verify (self-verification is prohibited server-side
  // regardless, but the dashboard should never even imply it). "Needs
  // Your Attention" is specifically for genuinely actionable work, so a
  // document this manager already sent and is merely waiting on someone
  // else for is correctly excluded here entirely -- it's not something
  // that needs THEIR attention right now. It still shows up, correctly
  // labeled "Sent for Verification," in the Receiving Queue itself.
  const needsMyVerification = readyForVerification.filter(
    (item) => viewerRelationshipFor(item.createdByAppUserId, auth.manager.appUserId) === "eligible_verifier"
  );

  const attentionItems: { key: string; label: string; actionLabel: string; href: string }[] = [];
  if (needsMyVerification.length > 0) {
    attentionItems.push({
      key: "needs-verification",
      label: `${needsMyVerification.length} ${needsMyVerification.length === 1 ? "invoice" : "invoices"} need${needsMyVerification.length === 1 ? "s" : ""} your verification`,
      actionLabel: "Verify →",
      href: "/manager/receiving?tab=READY_FOR_VERIFICATION",
    });
  }
  if (ownDrafts.length > 0) {
    attentionItems.push({
      key: "cycle-count-in-progress",
      label: `${ownDrafts.length} cycle count${ownDrafts.length === 1 ? "" : "s"} in progress`,
      actionLabel: "Resume →",
      href: ownDrafts.length === 1 ? `/manager/inventory/cycle-count/${ownDrafts[0].cycleCountId}` : "/manager/inventory/cycle-count",
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-zinc-100">
        {greeting()}, {firstName}
      </h1>

      <div className="mt-6 flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Needs Your Attention</p>
        {attentionItems.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-sm text-zinc-500">Nothing needs your attention right now.</p>
          </div>
        ) : (
          attentionItems.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              className="flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900 p-4 hover:border-amber-400/40"
            >
              <span className="text-sm text-zinc-200">{item.label}</span>
              <span className="text-sm font-medium text-amber-400">{item.actionLabel}</span>
            </Link>
          ))
        )}
      </div>

      <div className="mt-8 flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Quick Actions</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/manager/receiving" className={secondaryButtonClass}>
            Upload Invoice
          </Link>
          <Link href="/manager/inventory" className={secondaryButtonClass}>
            Inventory
          </Link>
          <Link href="/manager/inventory/cycle-count" className={secondaryButtonClass}>
            Cycle Count
          </Link>
          <Link href="/manager/inventory/waste" className={secondaryButtonClass}>
            Inventory Waste
          </Link>
        </div>
      </div>
    </div>
  );
}
