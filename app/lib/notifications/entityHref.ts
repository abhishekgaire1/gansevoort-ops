import type { UserNotification } from "@/app/lib/notifications/types";

/**
 * Builds a notification's detail-page route from its trusted, database-
 * derived `entityType`/`entityId` -- never a raw URL supplied by the
 * database itself. Extracted from NotificationBell.tsx so this mapping
 * is directly unit-testable without rendering the component.
 */
export function entityHref(notification: Pick<UserNotification, "entityType" | "entityId">): string {
  if (notification.entityType === "purchase_document") {
    return `/manager/purchases/${notification.entityId}`;
  }
  if (notification.entityType === "inventory_cycle_count") {
    return `/manager/inventory/cycle-count/${notification.entityId}`;
  }
  if (notification.entityType === "inventory_waste_event") {
    return `/manager/inventory/waste/${notification.entityId}`;
  }
  if (notification.entityType === "exception") {
    return `/manager/inventory/alerts/${notification.entityId}`;
  }
  return "#";
}
