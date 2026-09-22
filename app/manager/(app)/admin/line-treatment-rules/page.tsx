import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { listVendorLineTreatmentRulesRpc } from "@/app/lib/purchaseDocuments/lineTreatmentRpcs";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { AdminLineTreatmentRulesView } from "./_components/AdminLineTreatmentRulesView";

/**
 * Admin -> Line Treatment Rules. Organization-scoped, vendor-specific
 * prior decisions ("Bartlett Dairy + SKU 99 CASES RETURNED -> returnable-
 * container credit") that the classifier surfaces as "Matched previous
 * decision". Created only when a manager explicitly ticks "Remember this
 * decision" while classifying a line -- never learned invisibly. Admins
 * can disable (and re-enable) a rule; a rule whose expense category was
 * deactivated is ignored automatically and shown as such here.
 */
export const dynamic = "force-dynamic";

export default async function AdminLineTreatmentRulesPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }
  const rules = await listVendorLineTreatmentRulesRpc(getServiceRoleClient(), auth.manager.organizationId);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Line Treatment Rules"
        description="Vendor-specific classification decisions managers chose to remember. Matched lines are labeled “Matched previous decision” and can always be changed on the invoice."
      />
      <AdminLineTreatmentRulesView initialRules={rules} />
    </div>
  );
}
