import Link from "next/link";
import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getManagerExpenseCategory, getManagerExpenseCategorySummary, listManagerExpenseCategoryLines } from "@/app/lib/categories/managerExpenseCategories";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { todayDateRange } from "@/app/lib/dateRanges/rollingPeriods";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { ExpenseCategoryDetailView } from "./_components/ExpenseCategoryDetailView";

/**
 * Manager -> Categories -> Expenses -> [category] (Part 23-32). Only
 * approved/persisted NON_INVENTORY lines from VERIFIED documents count
 * (Part 25-26) -- see the migration's own comment for the exact rule.
 * CREDIT_MEMO lines are excluded, not sign-flipped (Part 27) -- no
 * negative-amount semantics exist in this schema yet.
 */
export const dynamic = "force-dynamic";

export default async function ManagerExpenseCategoryDetailPage({ params }: { params: Promise<{ categoryId: string }> }) {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const { categoryId } = await params;
  const supabase = getServiceRoleClient();
  const category = await getManagerExpenseCategory(supabase, auth.manager.organizationId, categoryId);

  if (!category) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/categories" className={textLinkClass}>
          ← Categories
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Category not found.</p>
        </div>
      </div>
    );
  }

  const timezone = await resolveOrganizationTimezone(supabase, auth.manager.organizationId);
  const today = todayDateRange(new Date(), timezone);
  const [summary, lines] = await Promise.all([
    getManagerExpenseCategorySummary(supabase, auth.manager.organizationId, categoryId, today.startDate, today.endDate),
    listManagerExpenseCategoryLines(supabase, auth.manager.organizationId, categoryId, today.startDate, today.endDate, 25, 0),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/manager/categories" className={textLinkClass}>
        ← Categories
      </Link>

      <div className="mt-3 flex items-center gap-2">
        <h1 className="text-xl font-semibold text-zinc-100">{category.name}</h1>
        {!category.isActive ? <StatusBadge label="Inactive" tone="neutral" /> : null}
      </div>

      <div className="mt-5">
        <ExpenseCategoryDetailView categoryId={categoryId} initialSummary={summary} initialLines={lines} />
      </div>
    </div>
  );
}
