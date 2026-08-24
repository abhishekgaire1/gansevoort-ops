import { redirect } from "next/navigation";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listManagerInventoryCategories } from "@/app/lib/categories/managerInventoryCategories";
import { listManagerExpenseCategories } from "@/app/lib/categories/managerExpenseCategories";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { thisMonthRange } from "@/app/lib/dateRanges/calendarPeriods";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { ManagerCategoriesTabs } from "./_components/ManagerCategoriesTabs";

/**
 * Manager -> Categories (Flat Category Architecture milestone, Part
 * 15-18) -- a READ-ONLY operational exploration hub, deliberately NOT
 * under Admin. "What happened in this category?", never "what categories
 * exist?" (Part 16). Available to Manager and Admin, never kiosk
 * Employees -- requireManagerOrAdmin() is the same base check every other
 * manager page uses.
 */
export const dynamic = "force-dynamic";

export default async function ManagerCategoriesPage() {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const supabase = getServiceRoleClient();
  const timezone = await resolveOrganizationTimezone(supabase, auth.manager.organizationId);
  const { start, end } = thisMonthRange(new Date(), timezone);
  const startDate = start.toISOString().slice(0, 10);
  const endDateExclusive = new Date(end.getTime() - 1).toISOString().slice(0, 10);

  const [inventoryCategories, expenseCategories] = await Promise.all([
    listManagerInventoryCategories(supabase, auth.manager.organizationId),
    listManagerExpenseCategories(supabase, auth.manager.organizationId, startDate, endDateExclusive),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Categories" description="Explore inventory and expenses by category." />
      <ManagerCategoriesTabs initialInventoryCategories={inventoryCategories} initialExpenseCategories={expenseCategories} />
    </div>
  );
}
