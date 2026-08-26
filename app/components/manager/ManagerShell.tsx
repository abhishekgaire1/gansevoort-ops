"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NotificationBell } from "@/app/components/notifications/NotificationBell";
import { AskGansevoortLauncher } from "@/app/components/manager/askGansevoort/AskGansevoortLauncher";
import { signOutManager } from "@/app/actions/managerAuth";

/**
 * The persistent sidebar-first manager shell (Sidebar-First Manager
 * Navigation milestone) -- implemented ONCE in the shared (app) layout
 * so every manager page automatically inherits sidebar + top header +
 * notifications + account area + standard content container, rather
 * than each page building its own. Purely a layout/navigation change;
 * no page's own content or business logic is touched.
 *
 * Sidebar collapse preference is remembered via localStorage only (no
 * DB persistence -- it's a per-browser UI preference, not business
 * data). Defaults to expanded on first load/SSR to avoid a hydration
 * mismatch; syncs from localStorage right after mount.
 */

const COLLAPSE_STORAGE_KEY = "gansevoort-manager-sidebar-collapsed";

interface NavLeaf {
  label: string;
  href: string;
  isActive: (pathname: string) => boolean;
}

interface NavGroup {
  label: string;
  href: string;
  icon: ReactNode;
  isActive: (pathname: string) => boolean;
  children: NavLeaf[];
  /** Renders a thin divider above this item -- Admin Foundation
   * milestone's "Admin feels like configuration, not another
   * operational workflow" (Part 41): a visual break separates day-to-day
   * modules (Dashboard/Receiving/Inventory) from Admin, and Admin from
   * Settings, exactly matching the spec's own mockup. Settings carries
   * this even when Admin is hidden, so non-admin managers still see
   * Inventory/Settings separated the same way they always have. */
  separatorBefore?: boolean;
}

type NavItem = (NavLeaf & { icon: ReactNode; children?: undefined; separatorBefore?: boolean }) | NavGroup;

/** Admin Foundation milestone -- the Admin group is entirely OMITTED
 * (not rendered-but-disabled) for a non-admin manager (Part 3/30): this
 * function decides inclusion, the caller never has to remember to hide
 * it. isAdmin comes from the SAME server-resolved role array
 * requireManagerOrAdmin() already returns (see (app)/layout.tsx) --
 * never a client-only flag. */
function buildNav(isAdmin: boolean): NavItem[] {
  const nav: NavItem[] = [
    {
      label: "Dashboard",
      href: "/manager",
      icon: <DashboardIcon />,
      isActive: (p) => p === "/manager",
    },
    {
      label: "Receiving",
      href: "/manager/receiving",
      icon: <ReceivingIcon />,
      isActive: (p) => p.startsWith("/manager/receiving") || p.startsWith("/manager/purchases"),
    },
    {
      label: "Inventory",
      href: "/manager/inventory",
      icon: <InventoryIcon />,
      isActive: (p) => p.startsWith("/manager/inventory"),
      children: [
        {
          label: "Current Inventory",
          href: "/manager/inventory",
          // Item Detail (/manager/inventory/items/[itemId]) is a child of
          // Current Inventory, not a new sidebar entry (Inventory Item
          // Detail + Activity History milestone, Part 5) -- it must keep
          // this exact-match-only entry active too, without also matching
          // the sibling Cycle Count/Inventory Waste routes.
          isActive: (p) => p === "/manager/inventory" || p.startsWith("/manager/inventory/items"),
        },
        // Global Inventory Activity milestone -- its own sub-nav entry
        // (Part 1), never a new top-level module: still a child of
        // Inventory alongside Current Inventory/Cycle Count/Inventory
        // Waste.
        { label: "Activity", href: "/manager/inventory/activity", isActive: (p) => p.startsWith("/manager/inventory/activity") },
        { label: "Cycle Count", href: "/manager/inventory/cycle-count", isActive: (p) => p.startsWith("/manager/inventory/cycle-count") },
        { label: "Inventory Waste", href: "/manager/inventory/waste", isActive: (p) => p.startsWith("/manager/inventory/waste") },
        { label: "Inventory Alerts", href: "/manager/inventory/alerts", isActive: (p) => p.startsWith("/manager/inventory/alerts") },
      ],
    },
    // V1 Reports foundation -- everything here is a read-only aggregate
    // view over data Receiving/Inventory already trusts (Section 26-27);
    // never a place a report's own record-level detail lives (each report
    // row drills back to the real operational page instead).
    {
      label: "Reports",
      href: "/manager/reports",
      icon: <ReportsIcon />,
      isActive: (p) => p.startsWith("/manager/reports"),
      children: [
        { label: "Overview", href: "/manager/reports", isActive: (p) => p === "/manager/reports" },
        { label: "Purchasing", href: "/manager/reports/purchasing", isActive: (p) => p.startsWith("/manager/reports/purchasing") },
        { label: "Inventory Usage", href: "/manager/reports/usage", isActive: (p) => p.startsWith("/manager/reports/usage") },
        { label: "Inventory Status", href: "/manager/reports/inventory-status", isActive: (p) => p.startsWith("/manager/reports/inventory-status") },
        { label: "Waste", href: "/manager/reports/waste", isActive: (p) => p.startsWith("/manager/reports/waste") },
        { label: "Receiving", href: "/manager/reports/receiving", isActive: (p) => p.startsWith("/manager/reports/receiving") },
      ],
    },
    // Flat Category Architecture milestone: a READ-ONLY operational
    // drill-down, deliberately NOT under Admin (Part 15-16) -- "what
    // happened in this category," never "what categories exist." Visible
    // to every manager, not just Admins; Admin -> Categories (master-data
    // configuration) remains a separate destination under the Admin
    // group below.
    {
      label: "Categories",
      href: "/manager/categories",
      icon: <CategoriesIcon />,
      isActive: (p) => p.startsWith("/manager/categories"),
    },
  ];

  if (isAdmin) {
    nav.push({
      label: "Admin",
      href: "/manager/admin/users",
      icon: <AdminIcon />,
      isActive: (p) => p.startsWith("/manager/admin"),
      separatorBefore: true,
      children: [
        { label: "Users", href: "/manager/admin/users", isActive: (p) => p.startsWith("/manager/admin/users") },
        { label: "Stations", href: "/manager/admin/stations", isActive: (p) => p.startsWith("/manager/admin/stations") },
        { label: "Item Master", href: "/manager/admin/items", isActive: (p) => p.startsWith("/manager/admin/items") },
        // Admin Master Data milestone: Vendors and Categories are
        // Admin-only configuration, same as Item Master -- ONE Categories
        // entry (Inventory + Spend live as tabs on that one page), never
        // two sidebar entries (Part 2).
        { label: "Vendors", href: "/manager/admin/vendors", isActive: (p) => p.startsWith("/manager/admin/vendors") },
        { label: "Categories", href: "/manager/admin/categories", isActive: (p) => p.startsWith("/manager/admin/categories") },
        // AI Configuration + Usage/Cost Tracking milestone: the
        // centralized control layer for provider/model decisions and the
        // Admin-only Usage & Cost view (Part 3/45) both live on this one
        // route's two tabs.
        { label: "AI Configuration", href: "/manager/admin/ai", isActive: (p) => p.startsWith("/manager/admin/ai") },
      ],
    });
  }

  // Settings previously held Categories/Items/Vendors; Categories and
  // Vendors moved to Admin-only above (Part 15/23/41 -- general
  // administration of organization master data is Admin-only, not
  // something every Manager sees under "Settings"). Items is read-only
  // browse and stays Manager-visible, now as its own top-level entry
  // rather than a single-child "Settings" group. No separatorBefore here
  // -- Items is an ordinary operational module like Reports/Categories,
  // not a distinct section worth its own divider; a lone item sitting
  // below an otherwise-unexplained line looked like a rendering bug.
  nav.push({
    label: "Items",
    href: "/manager/items",
    icon: <ItemsIcon />,
    isActive: (p) => p.startsWith("/manager/items"),
  });

  return nav;
}

export function ManagerShell({ managerName, isAdmin, children }: { managerName: string; isAdmin: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    // Syncing local state from an external system (localStorage) on
    // mount -- the sanctioned use of an effect per this rule's own
    // guidance, not derivable state.
    const saved = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved === "1") setCollapsed(true);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-50">
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 transition-[width] duration-150 md:flex ${
          collapsed ? "md:w-[72px]" : "md:w-[232px]"
        }`}
      >
        <SidebarContent pathname={pathname} collapsed={collapsed} managerName={managerName} isAdmin={isAdmin} />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-10 flex h-full w-64 flex-col border-r border-zinc-800 bg-zinc-950">
            <SidebarContent pathname={pathname} collapsed={false} managerName={managerName} isAdmin={isAdmin} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3 md:px-6">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 md:hidden"
          >
            <MenuIcon />
          </button>
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((c) => !c)}
            className="hidden rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 md:inline-flex"
          >
            <CollapseIcon collapsed={collapsed} />
          </button>
          <div className="flex-1" />
          <NotificationBell />
        </header>
        <main className="flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
      </div>
      <AskGansevoortLauncher />
    </div>
  );
}

function SidebarContent({
  pathname,
  collapsed,
  managerName,
  isAdmin,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  managerName: string;
  isAdmin: boolean;
  onNavigate?: () => void;
}) {
  const nav = buildNav(isAdmin);
  return (
    <>
      <div className={`flex items-center border-b border-zinc-800 px-4 py-4 ${collapsed ? "justify-center px-0" : ""}`}>
        <Link href="/manager" onClick={onNavigate} className="text-xs font-semibold uppercase tracking-wide text-zinc-200 hover:text-zinc-100">
          {collapsed ? "GO" : "Gansevoort Ops"}
        </Link>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {nav.map((item) => (
          <div key={item.href}>
            {item.separatorBefore ? <div className="my-2 border-t border-zinc-800" /> : null}
            <NavEntry item={item} pathname={pathname} collapsed={collapsed} onNavigate={onNavigate} />
          </div>
        ))}
      </nav>

      <div className="border-t border-zinc-800 px-2 py-3">
        <div className={`flex items-center gap-2 rounded-lg px-2 py-2 ${collapsed ? "justify-center px-0" : ""}`} title={managerName}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-300">
            {managerName.slice(0, 1).toUpperCase() || "?"}
          </span>
          {!collapsed ? <span className="truncate text-sm text-zinc-300">{managerName}</span> : null}
        </div>
        <form action={signOutManager}>
          <button
            type="submit"
            title="Sign Out"
            className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300 ${
              collapsed ? "justify-center px-0" : ""
            }`}
          >
            <SignOutIcon />
            {!collapsed ? <span>Sign Out</span> : null}
          </button>
        </form>
      </div>
    </>
  );
}

function NavEntry({
  item,
  pathname,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const active = item.isActive(pathname);
  const hasChildren = "children" in item && item.children && item.children.length > 0;

  return (
    <div>
      <Link
        href={item.href}
        onClick={onNavigate}
        title={collapsed ? item.label : undefined}
        className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors ${
          collapsed ? "justify-center px-0" : ""
        } ${active ? "bg-zinc-900 font-medium text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"}`}
      >
        <span className={`shrink-0 ${active ? "text-amber-400" : "text-zinc-500"}`}>{item.icon}</span>
        {!collapsed ? <span className="truncate">{item.label}</span> : null}
      </Link>
      {/* Sub-navigation only exposes when its group is the active section
       * (Part "INVENTORY SUBNAVIGATION": "When Inventory is active,
       * expose..."), and never in collapsed/icon-rail mode -- there's no
       * room for indented labels at 72px, and the page itself still
       * surfaces its own quick actions (Part "DO NOT OVERLOAD THE
       * SIDEBAR"). */}
      {hasChildren && active && !collapsed ? (
        <div className="ml-[13px] mt-0.5 flex flex-col gap-0.5 border-l border-zinc-800 pl-4">
          {item.children!.map((child) => {
            const childActive = child.isActive(pathname);
            return (
              <Link
                key={child.href}
                href={child.href}
                onClick={onNavigate}
                className={`rounded-lg px-2 py-1.5 text-sm transition-colors ${
                  childActive ? "font-medium text-amber-400" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {child.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      {collapsed ? <path d="M13 10l3 2-3 2" /> : <path d="M15 10l-3 2 3 2" />}
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="M16 17l5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
    </svg>
  );
}

function DashboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </svg>
  );
}

function ReceivingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8l-9-5-9 5 9 5 9-5Z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  );
}

function InventoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  );
}

function ReportsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  );
}

function CategoriesIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3.24L3 3v6.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.83Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
  );
}

function ItemsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z" />
      <path d="M3 7.5 12 12l9-4.5" />
      <path d="M12 12v9" />
    </svg>
  );
}
