"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createAdminVendorAction, findSimilarVendorsAction } from "@/app/actions/adminVendors";
import type { SimilarVendorCandidate, VendorDetailsInput } from "@/app/lib/admin/vendors";
import { primaryButtonClass, secondaryButtonClass } from "@/app/components/manager/buttonStyles";

const EMPTY_FORM: VendorDetailsInput = { name: "", legalName: "", accountNumber: "", contactName: "", email: "", phone: "", notes: "" };

/**
 * Admin -> Vendors "+ Add Vendor" (Part 3-6). Duplicate protection is
 * two-tier, same pattern as Item Master's Add Item: an EXACT normalized
 * match is hard-BLOCKED server-side (create_vendor_admin, GA052) no
 * matter what; a POSSIBLE match (fuzzy similarity) only WARNS and
 * requires deliberately clicking "Create Anyway".
 */
export function AddVendorButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<VendorDetailsInput>(EMPTY_FORM);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<SimilarVendorCandidate[] | null>(null);
  const submittingRef = useRef(false);

  function reset() {
    setForm(EMPTY_FORM);
    setError(null);
    setCandidates(null);
  }

  async function doCreate() {
    setPending(true);
    setError(null);
    const result = await createAdminVendorAction(form);
    setPending(false);

    if (!result.ok) {
      if ("existingVendorId" in result && result.existingVendorId) {
        setCandidates([{ vendorId: result.existingVendorId, name: result.existingVendorName ?? "", similarity: 1, isExact: true }]);
        return;
      }
      setError("message" in result ? result.message : "Unable to save Vendor. Try again.");
      return;
    }

    setOpen(false);
    reset();
    router.refresh();
  }

  async function handleSubmit() {
    if (submittingRef.current) return;
    if (!form.name.trim()) {
      setError("Vendor name is required.");
      return;
    }

    submittingRef.current = true;
    try {
      if (candidates === null) {
        setPending(true);
        setError(null);
        const similar = await findSimilarVendorsAction(form.name);
        setPending(false);
        if (similar.ok && similar.candidates.length > 0) {
          setCandidates(similar.candidates);
          return;
        }
        await doCreate();
        return;
      }
      await doCreate();
    } finally {
      submittingRef.current = false;
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonClass}>
        + Add Vendor
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-5">
            <div className="flex items-start justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-300">Add Vendor</h2>
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                aria-label="Close"
                className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Vendor Name *
                <input
                  value={form.name}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, name: e.target.value }));
                    setCandidates(null);
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

            {candidates && candidates.length > 0 ? (
              <div className="mt-4 rounded-xl border border-amber-900/60 bg-amber-950/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">{candidates[0].isExact ? "Existing Vendor Found" : "Possible Existing Vendor"}</p>
                <ul className="mt-2 flex flex-col gap-2">
                  {candidates.map((c) => (
                    <li key={c.vendorId} className="flex items-center justify-between gap-2 text-sm text-zinc-300">
                      <span>{c.name}</span>
                      <a href={`/manager/admin/vendors/${c.vendorId}`} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-amber-400 hover:underline">
                        Use Existing →
                      </a>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-zinc-500">
                  {candidates[0].isExact ? "A vendor with this exact name already exists -- creating a duplicate is not allowed." : "This looks similar to an existing vendor. Review before creating a new one."}
                </p>
              </div>
            ) : null}

            {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}

            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className={secondaryButtonClass}
              >
                Cancel
              </button>
              {candidates && candidates.length > 0 && candidates[0].isExact ? null : (
                <button type="button" disabled={pending} onClick={handleSubmit} className={primaryButtonClass}>
                  {pending ? "Checking…" : candidates && candidates.length > 0 ? "Create Anyway" : "Add Vendor"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
