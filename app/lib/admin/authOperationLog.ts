import "server-only";
import { randomUUID } from "node:crypto";

/**
 * Safe, structured server-side diagnostic logging for privileged Supabase
 * Auth operations (invite / resend / password reset) -- added after a
 * real incident where a rate-limited invite could not be traced back to
 * a request count because nothing was logged at all (see
 * invitations.ts's own header comment for the full story).
 *
 * Deliberately narrow: only ever logs the fields listed in
 * AuthOperationLogFields below. NEVER pass an email address, password,
 * PIN, access/refresh/invite/reset token, or service key into this --
 * there is no field for any of them, by construction, so a caller cannot
 * accidentally log one through a typo'd extra property.
 */
export interface AuthOperationLogFields {
  operation: "invite" | "resend" | "password_reset";
  correlationId: string;
  organizationId: string;
  employeeId?: string;
  appUserId?: string;
  attempt: number;
  httpStatus?: number;
  authErrorCode?: string;
  result: "success" | "reconciled" | "rate_limited" | "already_registered" | "provider_error" | "validation_error" | "email_conflict";
}

export function newCorrelationId(): string {
  return randomUUID();
}

export function logAuthOperation(fields: AuthOperationLogFields): void {
  console.log(
    JSON.stringify({
      at: "auth_operation",
      timestamp: new Date().toISOString(),
      ...fields,
    })
  );
}
