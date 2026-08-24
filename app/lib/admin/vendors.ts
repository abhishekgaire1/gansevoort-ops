import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapAdminRpcError } from "@/app/lib/admin/errors";

/**
 * Admin Master Data milestone -- the Admin-only browse/detail/create/
 * update/deactivate-reactivate/alias surface for vendors. Operates on the
 * exact same vendors table the existing Receiving upload/classification
 * pipeline (app/actions/vendors.ts's read-only listVendors/searchVendors)
 * already reads -- never a parallel vendor system.
 */

export interface AdminVendorSummary {
  vendorId: string;
  name: string;
  isActive: boolean;
  accountNumber: string | null;
  contactName: string | null;
  mappingCount: number;
}

export interface ListAdminVendorsInput {
  organizationId: string;
  search?: string | null;
  status?: "active" | "inactive" | null;
}

export async function listAdminVendors(supabase: SupabaseClient, input: ListAdminVendorsInput): Promise<AdminVendorSummary[]> {
  let query = supabase
    .from("vendors")
    .select("id, name, is_active, account_number, contact_name")
    .eq("organization_id", input.organizationId)
    .order("name");

  if (input.status === "active") query = query.eq("is_active", true);
  if (input.status === "inactive") query = query.eq("is_active", false);
  if (input.search?.trim()) {
    const term = input.search.trim();
    query = query.or(`name.ilike.%${term}%,legal_name.ilike.%${term}%,account_number.ilike.%${term}%`);
  }

  const [{ data, error }, mappingCounts] = await Promise.all([query, countActiveVendorMappings(supabase, input.organizationId)]);
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    vendorId: row.id as string,
    name: row.name as string,
    isActive: row.is_active as boolean,
    accountNumber: (row.account_number as string | null) ?? null,
    contactName: (row.contact_name as string | null) ?? null,
    mappingCount: mappingCounts.get(row.id as string) ?? 0,
  }));
}

/** Item-mapping counts per vendor, computed in JS from a flat row fetch
 * rather than a nested PostgREST count-aggregate embed (no local
 * Supabase/Docker available in this environment to verify that syntax
 * against the actual PostgREST version -- this reduce is simple and
 * definitely correct). Active mappings only, matching what the Vendor
 * detail page's "Item Mappings" section actually means operationally. */
async function countActiveVendorMappings(supabase: SupabaseClient, organizationId: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.from("vendor_item_mappings").select("vendor_id").eq("organization_id", organizationId).eq("is_active", true);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const vendorId = row.vendor_id as string;
    counts.set(vendorId, (counts.get(vendorId) ?? 0) + 1);
  }
  return counts;
}

export interface AdminVendorDetail {
  vendorId: string;
  name: string;
  legalName: string | null;
  accountNumber: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

export async function getAdminVendor(supabase: SupabaseClient, organizationId: string, vendorId: string): Promise<AdminVendorDetail | null> {
  const { data, error } = await supabase
    .from("vendors")
    .select("id, name, legal_name, account_number, contact_name, email, phone, notes, is_active, created_at")
    .eq("organization_id", organizationId)
    .eq("id", vendorId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    vendorId: data.id as string,
    name: data.name as string,
    legalName: data.legal_name as string | null,
    accountNumber: data.account_number as string | null,
    contactName: data.contact_name as string | null,
    email: data.email as string | null,
    phone: data.phone as string | null,
    notes: data.notes as string | null,
    isActive: data.is_active as boolean,
    createdAt: data.created_at as string,
  };
}

export interface VendorAlias {
  aliasId: string;
  alias: string;
}

export async function listVendorAliases(supabase: SupabaseClient, organizationId: string, vendorId: string): Promise<VendorAlias[]> {
  const { data, error } = await supabase
    .from("vendor_aliases")
    .select("id, alias")
    .eq("organization_id", organizationId)
    .eq("vendor_id", vendorId)
    .order("alias");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ aliasId: row.id as string, alias: row.alias as string }));
}

export interface VendorItemMapping {
  mappingId: string;
  matchBasis: "VENDOR_SKU" | "NORMALIZED_DESCRIPTION";
  vendorSku: string | null;
  normalizedDescription: string | null;
  itemName: string;
  itemNumber: string | null;
  disposition: "INVENTORY" | "NON_INVENTORY";
}

/** View-only (Part 37) -- Admin can see approved mappings on the Vendor
 * detail page, never edit/remap them here; remapping semantics stay
 * exactly where they already live (the Receiving/classification review
 * surface). Active mappings only -- a superseded row is history, not a
 * currently-approved mapping. */
export async function getVendorItemMappings(supabase: SupabaseClient, organizationId: string, vendorId: string): Promise<VendorItemMapping[]> {
  const { data, error } = await supabase
    .from("vendor_item_mappings")
    .select("id, match_basis, vendor_sku, normalized_description, inventory_items(name, item_number, disposition)")
    .eq("organization_id", organizationId)
    .eq("vendor_id", vendorId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => {
    const item = Array.isArray(row.inventory_items) ? row.inventory_items[0] : row.inventory_items;
    return {
      mappingId: row.id as string,
      matchBasis: row.match_basis as "VENDOR_SKU" | "NORMALIZED_DESCRIPTION",
      vendorSku: (row.vendor_sku as string | null) ?? null,
      normalizedDescription: (row.normalized_description as string | null) ?? null,
      itemName: (item?.name as string | undefined) ?? "",
      itemNumber: (item?.item_number as string | null | undefined) ?? null,
      disposition: (item?.disposition as "INVENTORY" | "NON_INVENTORY" | undefined) ?? "INVENTORY",
    };
  });
}

export interface SimilarVendorCandidate {
  vendorId: string;
  name: string;
  similarity: number;
  isExact: boolean;
}

/** Fuzzy possible-duplicate search -- distinct from the hard exact-
 * duplicate BLOCK create_vendor_admin/update_vendor_details/create_
 * vendor_from_receiving all enforce. Called by the UI BEFORE submitting a
 * create, so the caller sees "possible existing vendor" and can
 * deliberately confirm past it. */
export async function findSimilarVendors(supabase: SupabaseClient, organizationId: string, name: string, excludeVendorId?: string): Promise<SimilarVendorCandidate[]> {
  if (!name.trim()) return [];
  const { data, error } = await supabase.rpc("find_similar_active_vendors", {
    p_organization_id: organizationId,
    p_name: name.trim(),
    p_exclude_vendor_id: excludeVendorId ?? null,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { out_vendor_id: string; out_name: string; out_similarity: number; out_is_exact: boolean }[]).map((row) => ({
    vendorId: row.out_vendor_id,
    name: row.out_name,
    similarity: row.out_similarity,
    isExact: row.out_is_exact,
  }));
}

export interface VendorDetailsInput {
  name: string;
  legalName?: string | null;
  accountNumber?: string | null;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
}

export async function createAdminVendor(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, input: VendorDetailsInput): Promise<{ vendorId: string }> {
  const { data, error } = await supabase.rpc("create_vendor_admin", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_name: input.name,
    p_legal_name: input.legalName ?? null,
    p_account_number: input.accountNumber ?? null,
    p_contact_name: input.contactName ?? null,
    p_email: input.email ?? null,
    p_phone: input.phone ?? null,
    p_notes: input.notes ?? null,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_vendor_id: string } | undefined;
  if (!row) throw new Error("create_vendor_admin returned no result");
  return { vendorId: row.out_vendor_id };
}

export async function updateAdminVendorDetails(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, vendorId: string, input: VendorDetailsInput): Promise<void> {
  const { error } = await supabase.rpc("update_vendor_details", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_vendor_id: vendorId,
    p_name: input.name,
    p_legal_name: input.legalName ?? null,
    p_account_number: input.accountNumber ?? null,
    p_contact_name: input.contactName ?? null,
    p_email: input.email ?? null,
    p_phone: input.phone ?? null,
    p_notes: input.notes ?? null,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function setAdminVendorActive(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, vendorId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase.rpc("set_vendor_active", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_vendor_id: vendorId,
    p_is_active: isActive,
  });
  if (error) throw mapAdminRpcError(error);
}

export async function addAdminVendorAlias(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, vendorId: string, alias: string): Promise<{ aliasId: string }> {
  const { data, error } = await supabase.rpc("add_vendor_alias", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_vendor_id: vendorId,
    p_alias: alias,
  });
  if (error) throw mapAdminRpcError(error);
  const row = (Array.isArray(data) ? data[0] : data) as { out_alias_id: string } | undefined;
  if (!row) throw new Error("add_vendor_alias returned no result");
  return { aliasId: row.out_alias_id };
}

export async function removeAdminVendorAlias(supabase: SupabaseClient, organizationId: string, actorAppUserId: string, aliasId: string): Promise<void> {
  const { error } = await supabase.rpc("remove_vendor_alias", {
    p_organization_id: organizationId,
    p_actor_app_user_id: actorAppUserId,
    p_alias_id: aliasId,
  });
  if (error) throw mapAdminRpcError(error);
}
