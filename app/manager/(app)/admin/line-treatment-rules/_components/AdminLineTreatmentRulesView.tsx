"use client";

import { useState } from "react";
import { setVendorLineTreatmentRuleActiveAction } from "@/app/actions/lineTreatment";
import type { VendorLineTreatmentRuleSummary } from "@/app/lib/purchaseDocuments/lineTreatmentRpcs";
import { LINE_TREATMENT_LABEL, CREDIT_SUBTYPE_LABEL } from "@/app/lib/purchaseDocuments/lineTreatment";
import { panelClass, tableWrapClass, tableClass, tableHeadClass, tableHeadCellClass, tableRowClass, tableCellClass, tableCellMutedClass, inlineErrorClass } from "@/app/components/manager/surfaces";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

export function AdminLineTreatmentRulesView({ initialRules }: { initialRules: VendorLineTreatmentRuleSummary[] }) {
  const [rules, setRules] = useState(initialRules);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(rule: VendorLineTreatmentRuleSummary) {
    if (pendingId) return;
    setPendingId(rule.ruleId);
    setError(null);
    const result = await setVendorLineTreatmentRuleActiveAction(rule.ruleId, !rule.isActive);
    setPendingId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRules((prev) => prev.map((r) => (r.ruleId === rule.ruleId ? { ...r, isActive: !rule.isActive } : r)));
  }

  if (rules.length === 0) {
    return <p className={`${panelClass} px-4 py-8 text-center text-sm text-zinc-500`}>No remembered decisions yet. Managers can tick “Remember this decision for this vendor” when classifying an invoice line.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className={inlineErrorClass}>{error}</p> : null}
      <div className={tableWrapClass}>
        <table className={tableClass}>
          <thead className={tableHeadClass}>
            <tr>
              <th className={tableHeadCellClass}>Vendor</th>
              <th className={tableHeadCellClass}>Matches</th>
              <th className={tableHeadCellClass}>Treatment</th>
              <th className={tableHeadCellClass}>Expense category</th>
              <th className={tableHeadCellClass}>Created</th>
              <th className={tableHeadCellClass}>Used</th>
              <th className={tableHeadCellClass}>Status</th>
              <th className={tableHeadCellClass}>Action</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => {
              const categoryInactive = rule.spendCategoryId !== null && rule.spendCategoryIsActive === false;
              return (
                <tr key={rule.ruleId} className={tableRowClass}>
                  <td className={tableCellClass}>{rule.vendorName}</td>
                  <td className={tableCellClass}>
                    {rule.vendorSku ? <p>SKU {rule.vendorSku}</p> : null}
                    {rule.normalizedDescription ? <p className="text-xs text-zinc-500">{rule.normalizedDescription}</p> : null}
                  </td>
                  <td className={tableCellClass}>
                    {LINE_TREATMENT_LABEL[rule.lineTreatment]}
                    {rule.creditSubtype ? <span className="block text-xs text-zinc-500">{CREDIT_SUBTYPE_LABEL[rule.creditSubtype]}</span> : null}
                    {rule.discountScope ? <span className="block text-xs text-zinc-500">{rule.discountScope === "LINE" ? "Line discount" : "Document discount"}</span> : null}
                  </td>
                  <td className={tableCellClass}>
                    {rule.spendCategoryName ?? "—"}
                    {categoryInactive ? <span className="block text-xs text-amber-300">Category disabled — rule ignored</span> : null}
                  </td>
                  <td className={tableCellMutedClass}>
                    {new Date(rule.createdAt).toLocaleDateString()}
                    {rule.createdByName ? <span className="block">{rule.createdByName}</span> : null}
                  </td>
                  <td className={tableCellMutedClass}>{rule.matchCount} line{rule.matchCount === 1 ? "" : "s"}</td>
                  <td className={tableCellClass}>
                    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${rule.isActive && !categoryInactive ? "text-emerald-400" : "text-zinc-500"}`}>
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${rule.isActive && !categoryInactive ? "bg-emerald-400" : "bg-zinc-500"}`} />
                      {rule.isActive ? (categoryInactive ? "Inactive (category)" : "Active") : "Disabled"}
                    </span>
                  </td>
                  <td className={tableCellClass}>
                    <button type="button" onClick={() => toggle(rule)} disabled={pendingId === rule.ruleId} className={secondaryButtonClass}>
                      {pendingId === rule.ruleId ? "Saving…" : rule.isActive ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
