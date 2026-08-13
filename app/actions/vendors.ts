"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { normalizeVendorName } from "@/app/lib/vendors/normalizeVendorName";

/**
 * Plain single-table CRUD -- no RPC needed (unlike documents/purchase
 * documents, nothing here writes across more than one table atomically).
 * AI/extraction code never calls anything in this file: vendor creation is
 * exclusively a manager-triggered action.
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

export type CreateVendorResult =
  | { ok: true; vendor: VendorSummary }
  | { ok: false; reason: "not_authorized" | "invalid_name" | "duplicate" | "misconfigured"; message: string };

export async function createVendor(name: string): Promise<CreateVendorResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { ok: false, reason: "invalid_name", message: "Vendor name is required." };
  }

  const serviceClient = getServiceRoleClient();
  const { data, error } = await serviceClient
    .from("vendors")
    .insert({
      organization_id: auth.manager.organizationId,
      name: trimmedName,
      normalized_name: normalizeVendorName(trimmedName),
    })
    .select("id, name, is_active")
    .single();

  if (error) {
    if (error.code === "23505") {
      return { ok: false, reason: "duplicate", message: `A vendor named "${trimmedName}" already exists.` };
    }
    return { ok: false, reason: "misconfigured", message: "Could not create the vendor. Try again." };
  }

  return { ok: true, vendor: { id: data.id, name: data.name, isActive: data.is_active } };
}

export type SetVendorActiveResult = { ok: true } | { ok: false; reason: "not_authorized" | "misconfigured"; message: string };

export async function setVendorActive(vendorId: string, isActive: boolean): Promise<SetVendorActiveResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();
  const { error } = await serviceClient
    .from("vendors")
    .update({ is_active: isActive })
    .eq("id", vendorId)
    .eq("organization_id", auth.manager.organizationId);

  if (error) {
    return { ok: false, reason: "misconfigured", message: "Could not update the vendor. Try again." };
  }

  return { ok: true };
}
