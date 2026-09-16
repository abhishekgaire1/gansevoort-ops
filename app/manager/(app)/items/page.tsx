import { redirect } from "next/navigation";

/**
 * The old read-only Items browse page was retired on 2026-09-16 when the
 * Item Master (/manager/admin/items) became the single canonical items
 * surface, full-capability for every manager. This route persists only
 * so old bookmarks keep working; the /manager/items/review recovery
 * queue below remains a real, separate work-queue route.
 */
export default function ItemsPage() {
  redirect("/manager/admin/items");
}
