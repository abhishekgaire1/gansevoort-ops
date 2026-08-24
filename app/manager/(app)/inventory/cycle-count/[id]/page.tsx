import { CycleCountView } from "../../_components/CycleCountView";

/**
 * A specific cycle count, by id -- an active DRAFT (own or blocked-view of
 * another manager's) or a read-only historical COMPLETED/CANCELLED detail
 * (Part "NAVIGATION" / "HISTORICAL DETAIL VIEW"). Ownership and status are
 * always re-derived server-side on load, never trusted from how this route
 * was reached (see CycleCountView's own "DIRECT URL PROTECTION" comment) --
 * this is the ONLY place a specific count's data loads, whether the hub
 * linked here via "Resume" or "View Details".
 */
export default async function CycleCountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-4xl">
      <CycleCountView initialCountId={id} />
    </div>
  );
}
