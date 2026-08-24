import { InventoryWasteHub } from "../_components/InventoryWasteHub";

/**
 * The Inventory Waste hub/history landing page (Part 4). "+ Record
 * Waste" routes to /waste/new; "View Details" routes to /waste/[id].
 */
export default function InventoryWastePage() {
  return (
    <div className="mx-auto max-w-4xl">
      <InventoryWasteHub />
    </div>
  );
}
