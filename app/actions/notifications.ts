"use server";

import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import type { UserNotification } from "@/app/lib/notifications/types";

/**
 * user_notifications is a plain, org-scoped, per-recipient inbox --
 * written transactionally by the RPCs that generate notifications (see
 * verify_purchase_document), read/marked-read here. No email/SMS/push in
 * this milestone; the manager layout's bell/dropdown polls this the same
 * lightweight way StatusPoller already works for extraction status.
 */

const NOTIFICATION_LIMIT = 30;

function mapRow(row: {
  id: string;
  type: string;
  entity_type: string;
  entity_id: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}): UserNotification {
  return {
    id: row.id,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    body: row.body,
    metadata: row.metadata,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export type ListNotificationsResult =
  | { ok: true; notifications: UserNotification[]; unreadCount: number }
  | { ok: false; reason: "not_authorized"; message: string };

export async function listNotifications(): Promise<ListNotificationsResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();

  const [{ data: rows }, { count: unreadCount }] = await Promise.all([
    serviceClient
      .from("user_notifications")
      .select("id, type, entity_type, entity_id, title, body, metadata, read_at, created_at")
      .eq("organization_id", auth.manager.organizationId)
      .eq("recipient_app_user_id", auth.manager.appUserId)
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_LIMIT),
    serviceClient
      .from("user_notifications")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", auth.manager.organizationId)
      .eq("recipient_app_user_id", auth.manager.appUserId)
      .is("read_at", null),
  ]);

  return { ok: true, notifications: (rows ?? []).map(mapRow), unreadCount: unreadCount ?? 0 };
}

export type MarkNotificationReadResult = { ok: true } | { ok: false; reason: "not_authorized"; message: string };

/** Org- and recipient-scoped -- a manager can only ever mark their own
 * notifications read, never another manager's. */
export async function markNotificationRead(notificationId: string): Promise<MarkNotificationReadResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();
  await serviceClient
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId)
    .eq("organization_id", auth.manager.organizationId)
    .eq("recipient_app_user_id", auth.manager.appUserId)
    .is("read_at", null);

  return { ok: true };
}

export async function markAllNotificationsRead(): Promise<MarkNotificationReadResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();
  await serviceClient
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("organization_id", auth.manager.organizationId)
    .eq("recipient_app_user_id", auth.manager.appUserId)
    .is("read_at", null);

  return { ok: true };
}
