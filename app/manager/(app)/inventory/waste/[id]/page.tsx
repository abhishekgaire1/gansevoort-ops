import { WasteDetailView } from "../../_components/WasteDetailView";

/** A specific Inventory Waste event, by id -- read-only (Part 19). */
export default async function InventoryWasteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="mx-auto max-w-4xl">
      <WasteDetailView wasteEventId={id} />
    </div>
  );
}
