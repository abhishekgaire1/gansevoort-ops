"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";

/**
 * Admin Master Data milestone: general Vendor administration (create with
 * full details, rename, edit contact info, deactivate/reactivate, manage
 * aliases) moved to app/actions/adminVendors.ts, gated by requireAdmin() --
 * this file previously exposed createVendor/setVendorActive to ANY
 * manager with no admin/manager split at all, which was the exact gap
 * this milestone closes. What remains here is read access every manager
 * still needs (listVendors/searchVendors, unchanged) plus ONE new,
 * narrowly-scoped exception: createVendorFromReceiving, callable by any
 * Manager but only able to create a vendor by name -- nothing else (Part
 * 15-17/42). AI never calls anything in this file.
 */

export interface VendorSummary {
  id: string;
  name: string;
  isActive: boolean;
}

export type ListVendorsResult = { ok: true; vendors: VendorSummary[] } | { ok: false; reason: "not_authorized"; message: string };

export async function listVendors(includeInactive = false): Promise<ListVendorsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();
  let query = serviceClient
    .from("vendors")
    .select("id, name, is_active")
    .eq("organization_id", auth.manager.organizationId)
    .order("name");

  if (!includeInactive) {
    query = query.eq("is_active", true);
  }

  const { data } = await query;
  return { ok: true, vendors: (data ?? []).map((v) => ({ id: v.id, name: v.name, isActive: v.is_active })) };
}

export type SearchVendorsResult = { ok: true; vendors: VendorSummary[] } | { ok: false; reason: "not_authorized"; message: string };

/** Suggestion search for the upload/draft vendor combobox -- active
 * vendors only, matched by a simple case-insensitive substring on name. */
export async function searchVendors(query: string): Promise<SearchVendorsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();
  const trimmed = query.trim();
  let dbQuery = serviceClient
    .from("vendors")
    .select("id, name, is_active")
    .eq("organization_id", auth.manager.organizationId)
    .eq("is_active", true)
    .order("name")
    .limit(20);

  if (trimmed) {
    dbQuery = dbQuery.ilike("name", `%${trimmed}%`);
  }

  const { data } = await dbQuery;
  return { ok: true, vendors: (data ?? []).map((v) => ({ id: v.id, name: v.name, isActive: v.is_active })) };
}

export type CreateVendorFromReceivingResult =
  | { ok: true; vendor: VendorSummary }
  | { ok: false; reason: "not_authorized" | "invalid_name" | "duplicate" | "misconfigured"; message: string; existingVendorId?: string; existingVendorName?: string };

/** The controlled Manager exception (Part 15-17/42): a Manager reviewing a
 * real invoice may create a NEW Vendor when no existing match is found,
 * so Receiving never stalls waiting on an Admin. Deliberately minimal --
 * name only, nothing else settable here. purchaseDocumentId is optional:
 * the current upload flow (UploadDocumentForm) selects a vendor BEFORE a
 * purchase_document exists, while the Step1ReviewInvoice vendor-
 * correction step has one already -- when present it's recorded on the
 * audit event only, for traceability of which invoice prompted the
 * creation, never as a second attachment mechanism (the caller sets the
 * returned vendor id through the exact same field -- vendorId state
 * before upload, or the header vendorId correction -- it already uses). */
export async function createVendorFromReceiving(name: string, purchaseDocumentId?: string | null): Promise<CreateVendorFromReceivingResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { ok: false, reason: "invalid_name", message: "Vendor name is required." };
  }

  const { data, error } = await getServiceRoleClient().rpc("create_vendor_from_receiving", {
    p_organization_id: auth.manager.organizationId,
    p_actor_app_user_id: auth.manager.appUserId,
    p_vendor_name: trimmedName,
    p_purchase_document_id: purchaseDocumentId ?? null,
  });

  if (error) {
    if (error.code === "GA052") {
      let existingVendorId: string | undefined;
      let existingVendorName: string | undefined;
      try {
        const parsed = JSON.parse(error.details ?? "{}") as { existingVendorId?: string; existingVendorName?: string };
        existingVendorId = parsed.existingVendorId;
        existingVendorName = parsed.existingVendorName;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
      return { ok: false, reason: "duplicate", message: error.message, existingVendorId, existingVendorName };
    }
    return { ok: false, reason: "misconfigured", message: "Could not create the vendor. Try again." };
  }

  const row = (Array.isArray(data) ? data[0] : data) as { out_vendor_id: string; out_name: string } | undefined;
  if (!row) {
    return { ok: false, reason: "misconfigured", message: "Could not create the vendor. Try again." };
  }

  return { ok: true, vendor: { id: row.out_vendor_id, name: row.out_name, isActive: true } };
}
