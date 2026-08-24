"use server";

import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import {
  listAdminVendors,
  getAdminVendor,
  listVendorAliases,
  getVendorItemMappings,
  findSimilarVendors,
  createAdminVendor,
  updateAdminVendorDetails,
  setAdminVendorActive,
  addAdminVendorAlias,
  removeAdminVendorAlias,
  type AdminVendorSummary,
  type AdminVendorDetail,
  type VendorAlias,
  type VendorItemMapping,
  type SimilarVendorCandidate,
  type VendorDetailsInput,
} from "@/app/lib/admin/vendors";
import { AdminActionError } from "@/app/lib/admin/errors";

/**
 * Admin Master Data milestone -- Admin-only Server Actions for the general
 * Vendor administration surface (create/rename/edit details/deactivate/
 * reactivate/aliases). Every action here gates on requireAdmin(), not
 * requireManagerOrAdmin() -- general Vendor administration is Admin-only
 * (Part 15/41); the ONE controlled exception (a Manager creating a new
 * Vendor from inside Receiving when no match exists) lives in a SEPARATE,
 * narrowly-scoped action -- see createVendorFromReceiving in
 * app/actions/vendors.ts, which stays Manager-callable but calls a
 * different, minimal RPC (create_vendor_from_receiving) that cannot set
 * any field besides the vendor name.
 */

type AuthFailure = { ok: false; reason: "not_authorized"; message: string };
const NOT_AUTHORIZED: AuthFailure = { ok: false, reason: "not_authorized", message: "You must be signed in as an Admin." };

export type ListAdminVendorsResult = { ok: true; vendors: AdminVendorSummary[] } | AuthFailure;

export async function listAdminVendorsAction(search: string | null, status: "active" | "inactive" | null): Promise<ListAdminVendorsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const vendors = await listAdminVendors(getServiceRoleClient(), { organizationId: auth.manager.organizationId, search, status });
  return { ok: true, vendors };
}

export type GetAdminVendorResult =
  | { ok: true; vendor: AdminVendorDetail; aliases: VendorAlias[]; mappings: VendorItemMapping[] }
  | AuthFailure
  | { ok: false; reason: "not_found"; message: string };

export async function getAdminVendorAction(vendorId: string): Promise<GetAdminVendorResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const supabase = getServiceRoleClient();
  const vendor = await getAdminVendor(supabase, auth.manager.organizationId, vendorId);
  if (!vendor) return { ok: false, reason: "not_found", message: "Vendor not found." };

  const [aliases, mappings] = await Promise.all([
    listVendorAliases(supabase, auth.manager.organizationId, vendorId),
    getVendorItemMappings(supabase, auth.manager.organizationId, vendorId),
  ]);

  return { ok: true, vendor, aliases, mappings };
}

export type FindSimilarVendorsResult = { ok: true; candidates: SimilarVendorCandidate[] } | AuthFailure;

export async function findSimilarVendorsAction(name: string, excludeVendorId?: string): Promise<FindSimilarVendorsResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  const candidates = await findSimilarVendors(getServiceRoleClient(), auth.manager.organizationId, name, excludeVendorId);
  return { ok: true, candidates };
}

export type AdminVendorMutationResult = { ok: true } | AuthFailure | { ok: false; reason: "error"; code: string; message: string; existingVendorId?: string; existingVendorName?: string };

function toMutationResult(err: unknown): AdminVendorMutationResult {
  if (err instanceof AdminActionError) {
    let existingVendorId: string | undefined;
    let existingVendorName: string | undefined;
    if (err.code === "DUPLICATE_VENDOR_NAME" && err.detail) {
      try {
        const parsed = JSON.parse(err.detail) as { existingVendorId?: string; existingVendorName?: string };
        existingVendorId = parsed.existingVendorId;
        existingVendorName = parsed.existingVendorName;
      } catch {
        // Detail wasn't parseable JSON -- fall back to the message alone.
      }
    }
    return { ok: false, reason: "error", code: err.code, message: err.message, existingVendorId, existingVendorName };
  }
  return { ok: false, reason: "error", code: "UNKNOWN", message: "Unable to save Vendor. Try again." };
}

export type CreateAdminVendorResult = { ok: true; vendorId: string } | AuthFailure | { ok: false; reason: "error"; code: string; message: string; existingVendorId?: string; existingVendorName?: string };

export async function createAdminVendorAction(input: VendorDetailsInput): Promise<CreateAdminVendorResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!input.name.trim()) {
    return { ok: false, reason: "error", code: "VALIDATION", message: "Vendor name is required." };
  }

  try {
    const result = await createAdminVendor(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, input);
    return { ok: true, vendorId: result.vendorId };
  } catch (err) {
    const mapped = toMutationResult(err);
    if (mapped.ok) throw err;
    return mapped;
  }
}

export async function updateAdminVendorDetailsAction(vendorId: string, input: VendorDetailsInput): Promise<AdminVendorMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!input.name.trim()) {
    return { ok: false, reason: "error", code: "VALIDATION", message: "Vendor name is required." };
  }

  try {
    await updateAdminVendorDetails(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, vendorId, input);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export async function setAdminVendorActiveAction(vendorId: string, isActive: boolean): Promise<AdminVendorMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await setAdminVendorActive(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, vendorId, isActive);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}

export type AddVendorAliasResult = { ok: true; aliasId: string } | AuthFailure | { ok: false; reason: "error"; code: string; message: string };

export async function addAdminVendorAliasAction(vendorId: string, alias: string): Promise<AddVendorAliasResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  if (!alias.trim()) {
    return { ok: false, reason: "error", code: "VALIDATION", message: "Alias text is required." };
  }

  try {
    const result = await addAdminVendorAlias(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, vendorId, alias);
    return { ok: true, aliasId: result.aliasId };
  } catch (err) {
    const mapped = toMutationResult(err);
    if (mapped.ok || !("code" in mapped)) throw err;
    return { ok: false, reason: "error", code: mapped.code, message: mapped.message };
  }
}

export async function removeAdminVendorAliasAction(aliasId: string): Promise<AdminVendorMutationResult> {
  const auth = await requireAdmin();
  if (!auth.ok) return NOT_AUTHORIZED;

  try {
    await removeAdminVendorAlias(getServiceRoleClient(), auth.manager.organizationId, auth.manager.appUserId, aliasId);
    return { ok: true };
  } catch (err) {
    return toMutationResult(err);
  }
}
