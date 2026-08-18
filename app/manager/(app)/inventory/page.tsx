import { InventoryBalancesView } from "./_components/InventoryBalancesView";

/**
 * The Item + Location inventory balance page. Every number here derives
 * from the append-only inventory ledger (list_inventory_balances) -- there
 * is no separately-editable "current quantity" anywhere. The full-stock
 * reference (the 100% denominator) is a visualization baseline only,
 * reset automatically by each genuine restock and overridable by a
 * manager -- never ledger truth.
 */
export default function InventoryPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="text-xl font-semibold">Inventory</h1>
      <InventoryBalancesView />
    </div>
  );
}
