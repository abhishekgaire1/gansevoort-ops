/**
 * Minimal in-app notification shape -- no email/SMS/push in this
 * milestone. `type`/`metadata` are intentionally generic (not just
 * purchase-document-specific) so this table can be reused by later
 * milestones' notification needs without a schema change.
 */
export interface UserNotification {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}
