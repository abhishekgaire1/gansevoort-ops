"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateAdminVendorDetailsAction, setAdminVendorActiveAction, addAdminVendorAliasAction, removeAdminVendorAliasAction } from "@/app/actions/adminVendors";
import type { AdminVendorDetail, VendorAlias, VendorItemMapping, VendorDetailsInput } from "@/app/lib/admin/vendors";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { textLinkClass, primaryButtonClass, secondaryButtonClass, destructiveButtonClass } from "@/app/components/manager/buttonStyles";

/**
 * Admin -> Vendor detail (Part 9-13/37). Rename preserves the same
 * Vendor ID/mappings/historical documents (Part 10) -- this is a plain
 * update_vendor_details call, never a new row. No hard delete anywhere
 * (Part 11) -- Deactivate/Reactivate only. Item Mappings is view-only
 * (Part 37) -- remapping stays on the Receiving/classification surface.
 */
export function AdminVendorDetailView({ vendor, aliases, mappings }: { vendor: AdminVendorDetail; aliases: VendorAlias[]; mappings: VendorItemMapping[] }) {
  const router = useRouter();
  const [form, setForm] = useState<VendorDetailsInput>({
    name: vendor.name,
    legalName: vendor.legalName ?? "",
    accountNumber: vendor.accountNumber ?? "",
    contactName: vendor.contactName ?? "",
    email: vendor.email ?? "",
    phone: vendor.phone ?? "",
    notes: vendor.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<{ existingVendorId: string; existingVendorName: string } | null>(null);

  const [statusConfirmOpen, setStatusConfirmOpen] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [newAlias, setNewAlias] = useState("");
  const [aliasPending, setAliasPending] = useState(false);
  const [aliasError, setAliasError] = useState<string | null>(null);

  const isActive = vendor.isActive;
  const dirty =
    form.name !== vendor.name ||
    (form.legalName ?? "") !== (vendor.legalName ?? "") ||
    (form.accountNumber ?? "") !== (vendor.accountNumber ?? "") ||
    (form.contactName ?? "") !== (vendor.contactName ?? "") ||
    (form.email ?? "") !== (vendor.email ?? "") ||
    (form.phone ?? "") !== (vendor.phone ?? "") ||
    (form.notes ?? "") !== (vendor.notes ?? "");

  async function handleSave() {
    if (saving || !dirty) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(null);
    setDuplicateOf(null);

    const result = await updateAdminVendorDetailsAction(vendor.vendorId, form);
    setSaving(false);
    if (!result.ok) {
      if ("existingVendorId" in result && result.existingVendorId && result.existingVendorName) {
        setDuplicateOf({ existingVendorId: result.existingVendorId, existingVendorName: result.existingVendorName });
        return;
      }
      setSaveError("message" in result ? result.message : "Unable to save Vendor.");
      return;
    }

    setSaveSuccess("Vendor updated.");
    router.refresh();
  }

  async function handleConfirmStatusChange() {
    if (statusSaving) return;
    setStatusSaving(true);
    setStatusError(null);
    const result = await setAdminVendorActiveAction(vendor.vendorId, !isActive);
    setStatusSaving(false);
    if (!result.ok) {
      setStatusError("message" in result ? result.message : "Unable to update status.");
      return;
    }
    setStatusConfirmOpen(false);
    router.refresh();
  }

  async function handleAddAlias() {
    if (aliasPending || !newAlias.trim()) return;
    setAliasPending(true);
    setAliasError(null);
    const result = await addAdminVendorAliasAction(vendor.vendorId, newAlias);
    setAliasPending(false);
    if (!result.ok) {
      setAliasError("message" in result ? result.message : "Unable to add alias.");
      return;
    }
    setNewAlias("");
    router.refresh();
  }

  async function handleRemoveAlias(aliasId: string) {
    setAliasError(null);
    const result = await removeAdminVendorAliasAction(aliasId);
    if (!result.ok) {
      setAliasError("message" in result ? result.message : "Unable to remove alias.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <Link href="/manager/admin/vendors" className={textLinkClass}>
        ← Vendors
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-zinc-100">{vendor.name}</h1>
        <div className="mt-1">
          <StatusBadge label={isActive ? "Active" : "Inactive"} tone={isActive ? "success" : "neutral"} />
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Vendor Information</p>
        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Vendor Name *
            <input
              value={form.name}
              onChange={(e) => {
                setForm((f) => ({ ...f, name: e.target.value }));
                setDuplicateOf(null);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Legal Name
            <input value={form.legalName ?? ""} onChange={(e) => setForm((f) => ({ ...f, legalName: e.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Vendor / Account Number
            <input value={form.accountNumber ?? ""} onChange={(e) => setForm((f) => ({ ...f, accountNumber: e.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Contact Name
            <input value={form.contactName ?? ""} onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Email
            <input value={form.email ?? ""} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Phone
            <input value={form.phone ?? ""} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Notes
            <textarea value={form.notes ?? ""} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-50" />
          </label>
        </div>

        {duplicateOf ? (
          <div className="mt-3 rounded-xl border border-amber-900/60 bg-amber-950/20 p-3">
            <p className="text-sm text-amber-300">
              A vendor named &ldquo;{duplicateOf.existingVendorName}&rdquo; already exists.{" "}
              <a href={`/manager/admin/vendors/${duplicateOf.existingVendorId}`} className="underline">
                View it
              </a>
              .
            </p>
          </div>
        ) : null}
        {saveError ? <p className="mt-3 text-sm text-red-400">{saveError}</p> : null}
        {saveSuccess ? <p className="mt-3 text-sm text-emerald-400">{saveSuccess}</p> : null}

        <button type="button" disabled={saving || !dirty} onClick={handleSave} className={`mt-4 ${primaryButtonClass}`}>
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Document Aliases</p>
        <p className="mt-1 text-xs text-zinc-500">Alternate names this vendor&apos;s invoices use (e.g. shortened or legal-entity variants) -- matching an alias resolves to this vendor automatically.</p>
        <div className="mt-3 flex flex-col divide-y divide-zinc-800">
          {aliases.length === 0 ? (
            <p className="py-2 text-sm text-zinc-500">No aliases yet.</p>
          ) : (
            aliases.map((a) => (
              <div key={a.aliasId} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="text-zinc-200">{a.alias}</span>
                <button type="button" onClick={() => handleRemoveAlias(a.aliasId)} className="text-xs text-zinc-500 hover:text-red-400">
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={newAlias}
            onChange={(e) => setNewAlias(e.target.value)}
            placeholder="Add alias…"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-50"
          />
          <button type="button" disabled={aliasPending || !newAlias.trim()} onClick={handleAddAlias} className={secondaryButtonClass}>
            {aliasPending ? "Adding…" : "+ Add Alias"}
          </button>
        </div>
        {aliasError ? <p className="mt-2 text-sm text-red-400">{aliasError}</p> : null}
      </div>

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Item Mappings</p>
        {mappings.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No item mappings yet.</p>
        ) : (
          <div className="mt-3 flex flex-col divide-y divide-zinc-800">
            {mappings.map((m) => (
              <div key={m.mappingId} className="py-2 text-sm">
                <p className="text-zinc-200">
                  {m.matchBasis === "VENDOR_SKU" ? m.vendorSku : m.normalizedDescription}
                  <span className="text-zinc-500"> → </span>
                  {m.disposition === "NON_INVENTORY" ? <span className="text-zinc-400">Non-Inventory</span> : null}
                  {m.itemNumber ? <span className="font-mono text-xs text-zinc-500">{m.itemNumber} </span> : null}
                  {m.itemName}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col items-start gap-2">
        <button type="button" onClick={() => setStatusConfirmOpen(true)} className={isActive ? destructiveButtonClass : primaryButtonClass}>
          {isActive ? "Deactivate Vendor" : "Reactivate Vendor"}
        </button>
        {statusError ? <p className="text-sm text-red-400">{statusError}</p> : null}
      </div>

      {statusConfirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <h2 className="text-sm font-semibold text-zinc-100">{isActive ? `Deactivate ${vendor.name}?` : `Reactivate ${vendor.name}?`}</h2>
            <p className="mt-2 text-sm text-zinc-400">
              {isActive
                ? "This vendor will no longer be selectable for new invoice uploads. Documents that already reference it are unaffected."
                : "This vendor will become selectable for new invoice uploads again."}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button type="button" disabled={statusSaving} onClick={() => setStatusConfirmOpen(false)} className={secondaryButtonClass}>
                Cancel
              </button>
              <button type="button" disabled={statusSaving} onClick={handleConfirmStatusChange} className={isActive ? destructiveButtonClass : primaryButtonClass}>
                {statusSaving ? "Saving…" : isActive ? "Deactivate" : "Reactivate"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
