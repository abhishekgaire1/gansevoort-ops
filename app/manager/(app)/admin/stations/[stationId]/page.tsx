import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getAdminStation } from "@/app/lib/admin/stations";
import { textLinkClass } from "@/app/components/manager/buttonStyles";
import { AdminStationDetailView } from "./_components/AdminStationDetailView";

export const dynamic = "force-dynamic";

export default async function AdminStationDetailPage({ params }: { params: Promise<{ stationId: string }> }) {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const { stationId } = await params;
  const station = await getAdminStation(getServiceRoleClient(), auth.manager.organizationId, stationId);

  if (!station) {
    return (
      <div className="mx-auto max-w-2xl">
        <Link href="/manager/admin/stations" className={textLinkClass}>
          ← Stations
        </Link>
        <div className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-400">Station not found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <AdminStationDetailView station={station} />
    </div>
  );
}
