"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { listAdminUsersAction } from "@/app/actions/adminUsers";
import type { AdminUserSummary, EmployeeStatus, PrimaryRole } from "@/app/lib/admin/users";
import type { KioskStation } from "@/app/lib/kiosk/stations";
import { StatusBadge } from "@/app/components/manager/StatusBadge";
import { secondaryButtonClass } from "@/app/components/manager/buttonStyles";

const ROLE_LABEL: Record<PrimaryRole, string> = { employee: "Employee", manager: "Manager", admin: "Admin" };
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Identity + Access Management milestone, Part 26/41 -- the list row
 * deliberately never fetches per-row Auth Admin API data (email,
 * invited/active) the way the detail page does (Part 25): that would be
 * an N+1 Admin API call per row. This surfaces only what list_admin_users
 * already returns, kept honest rather than fabricated.
 *
 * Checks provisioningStatus BEFORE hasAuthAccount: a Manager/Admin whose
 * invite failed or is still sending has hasAuthAccount === false, but
 * must never read as a plain kiosk employee (the post-launch bug this
 * milestone fixes -- see AddUserButton.tsx's header comment).
 */
function accessSummary(user: AdminUserSummary): { text: string; incomplete: boolean } {
  if (user.provisioningStatus === "invite_failed") {
    return { text: "Invitation Failed", incomplete: true };
  }
  if (user.provisioningStatus === "invite_pending") {
    return { text: "Invitation Sending…", incomplete: true };
  }
  if (user.hasAuthAccount) {
    return { text: `App Access · ${user.isAppUserActive ? "Active" : "Disabled"}`, incomplete: false };
  }
  if (user.appUserId) {
    const station = user.defaultStationName ? ` / Default: ${user.defaultStationName}` : "";
    return { text: `Kiosk Access · ${user.isAppUserActive ? "Active" : "Disabled"}${station}`, incomplete: false };
  }
  return { text: "No access configured", incomplete: false };
}

/**
 * Admin -> Users list (Admin Foundation milestone, Part 7/41) -- compact,
 * scannable rows, never a raw database table. Filters re-fetch through
 * the server action (same debounced-search convention as the Global
 * Inventory Activity page).
 */
export function AdminUsersView({ initialUsers }: { initialUsers: AdminUserSummary[]; stations: KioskStation[] }) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<PrimaryRole | "ALL">("ALL");
  const [status, setStatus] = useState<EmployeeStatus | "ALL">("ALL");
  const [users, setUsers] = useState<AdminUserSummary[]>(initialUsers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFirstRender = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAdminUsersAction(search.trim() || null, role === "ALL" ? null : role, status === "ALL" ? null : status).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setError("Unable to load users.");
        return;
      }
      setUsers(result.users);
    });
    return () => {
      cancelled = true;
    };
  }, [search, role, status]);

  const hasActiveFilters = search.trim() !== "" || role !== "ALL" || status !== "ALL";

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setRole("ALL");
    setStatus("ALL");
  }

  return (
    <div className="mt-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
        <label className="flex flex-1 min-w-[180px] flex-col gap-1 text-xs text-zinc-400">
          Search
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search users…"
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as PrimaryRole | "ALL")} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
            <option value="ALL">All</option>
            <option value="employee">Employee</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as EmployeeStatus | "ALL")} className="rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100">
            <option value="ALL">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-900 bg-red-950/40 p-4">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      ) : users.length === 0 && !loading ? (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <p className="text-sm text-zinc-500">No users match these filters.</p>
          {hasActiveFilters ? (
            <button type="button" onClick={clearFilters} className={`mt-3 ${secondaryButtonClass}`}>
              Clear Filters
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-zinc-800 rounded-2xl border border-zinc-800 bg-zinc-900">
          {users.map((user) => {
            const access = accessSummary(user);
            return (
              <Link
                key={user.employeeId}
                href={`/manager/admin/users/${user.employeeId}`}
                className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-zinc-800/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {ROLE_LABEL[user.displayRole]} / {access.text}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {access.incomplete ? (
                    <StatusBadge label="Setup Incomplete" tone="warning" />
                  ) : (
                    <StatusBadge label={user.employeeStatus === "active" ? "Active" : "Inactive"} tone={user.employeeStatus === "active" ? "success" : "neutral"} />
                  )}
                  <span className="text-xs font-medium text-amber-400">{access.incomplete ? "Finish Setup →" : "View / Edit →"}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
