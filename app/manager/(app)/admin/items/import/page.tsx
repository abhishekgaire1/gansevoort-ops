import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listInventoryCategories } from "@/app/actions/itemMaster";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { BulkImportView } from "./_components/BulkImportView";

/**
 * Admin -> Item Master -> Bulk Import (Part 16-20/70) -- Admin-only.
 * Server-enforces requireAdmin() itself; a Manager hitting this route
 * directly is redirected (Part 56).
 */
export const dynamic = "force-dynamic";

export default async function BulkImportPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const supabase = getServiceRoleClient();
  const [categoriesResult, unitsResult] = await Promise.all([listInventoryCategories(), supabase.from("units").select("id, code, name").order("name")]);
  const categories = categoriesResult.ok ? categoriesResult.categories : [];
  const units = (unitsResult.data ?? []).map((u) => ({ id: u.id as string, code: u.code as string, name: u.name as string }));

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/manager/admin/items" className={textLinkClass}>
        ← Item Master
      </Link>
      <h1 className="mt-1 text-xl font-semibold text-zinc-100">Import Item Master</h1>
      <p className="mt-1 text-sm text-zinc-400">Upload a CSV or XLSX file to add items to the catalog. Nothing imports until you confirm the preview.</p>
      <BulkImportView categories={categories} units={units} />
    </div>
  );
}
