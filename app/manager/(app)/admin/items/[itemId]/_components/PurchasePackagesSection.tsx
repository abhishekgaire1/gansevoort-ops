"use client";

import { useState } from "react";
import type { VendorPackageSummary } from "@/app/lib/admin/vendorPackages";
import { panelClass, panelHeaderClass, panelBodyClass, panelTitleClass, panelMetaClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableRowClass, tableCellClass } from "@/app/components/manager/surfaces";
import { EditVendorPackageDialog } from "./EditVendorPackageDialog";
import { ReceiptCorrectionFlow } from "./ReceiptCorrectionFlow";

/**
 * Item workspace Purchase Packages (spec section 3/7) -- one row per
 * active vendor/SKU configuration. "Edit package" defaults to future
 * receipts only (EditVendorPackageDialog); "Correct inventory from
 * previous receipts" is a SEPARATE, explicit action
 * (ReceiptCorrectionFlow) -- never automatic, never bundled into the
 * plain edit.
 */
export function PurchasePackagesSection({ packages, canEdit, baseUnitCode }: { packages: VendorPackageSummary[]; canEdit: boolean; baseUnitCode: string }) {
  const [editingMappingId, setEditingMappingId] = useState<string | null>(null);
  const [correctingPackageId, setCorrectingPackageId] = useState<string | null>(null);

  const editing = packages.find((p) => p.vendorItemMappingId === editingMappingId) ?? null;
  const correcting = packages.find((p) => p.package?.vendorItemPurchaseUnitId === correctingPackageId) ?? null;

  return (
    <div className={panelClass}>
      <div className={panelHeaderClass}>
        <p className={panelTitleClass}>Purchase Packages</p>
      </div>
      {packages.length === 0 ? (
        <div className={panelBodyClass}>
          <p className="text-sm text-zinc-500">No vendor purchase packages configured for this item yet.</p>
        </div>
      ) : (
        <div className={tableWrapClass}>
          <table className={tableClass}>
            <thead className={tableHeadClass}>
              <tr>
                <th className={tableHeadCellClass}>Vendor</th>
                <th className={tableHeadCellClass}>SKU</th>
                <th className={tableHeadCellClass}>Purchase unit</th>
                <th className={tableHeadCellClass}>Receiving behavior</th>
                <th className={tableHeadCellClass}>Conversion</th>
                <th className={tableHeadCellClass}>Effective</th>
                <th className={tableHeadCellClass}></th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.vendorItemMappingId} className={tableRowClass}>
                  <td className={tableCellClass}>{p.vendorName}</td>
                  <td className={tableCellClass}>{p.matchBasis === "VENDOR_SKU" ? p.vendorSku : p.normalizedDescription}</td>
                  <td className={tableCellClass}>{p.package?.purchaseUnitCode ?? "—"}</td>
                  <td className={tableCellClass}>{p.package?.receivingBehavior ?? "—"}</td>
                  <td className={tableCellClass}>
                    {p.package?.receivingBehavior === "FIXED_CONVERSION" && p.package.conversionFactor
                      ? `1 ${p.package.purchaseUnitCode} = ${p.package.conversionFactor} ${baseUnitCode}`
                      : p.package
                        ? "Measured at receiving"
                        : "—"}
                  </td>
                  <td className={tableCellClass}>{p.package ? new Date(p.package.effectiveFrom).toLocaleDateString() : "—"}</td>
                  <td className={`${tableCellClass} text-right`}>
                    {canEdit ? (
                      <div className="flex justify-end gap-3">
                        <button type="button" onClick={() => setEditingMappingId(p.vendorItemMappingId)} className="text-xs font-medium text-amber-400 hover:text-amber-300">
                          Edit package
                        </button>
                        {p.package ? (
                          <button type="button" onClick={() => setCorrectingPackageId(p.package!.vendorItemPurchaseUnitId)} className="text-xs font-medium text-zinc-400 hover:text-zinc-200">
                            Correct past receipts
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={`${panelBodyClass} border-t border-zinc-800`}>
        <p className={panelMetaClass}>
          Editing a package here applies to future receipts only -- previously posted receipts and current inventory are never silently recalculated.
        </p>
      </div>

      {editing ? <EditVendorPackageDialog pkg={editing} baseUnitCode={baseUnitCode} onClose={() => setEditingMappingId(null)} /> : null}
      {correcting?.package ? <ReceiptCorrectionFlow vendorItemPurchaseUnitId={correcting.package.vendorItemPurchaseUnitId} baseUnitCode={baseUnitCode} onClose={() => setCorrectingPackageId(null)} /> : null}
    </div>
  );
}
