import "server-only";

/**
 * PIN uniqueness is organization-scoped, so PIN verification needs an
 * organization_id -- but it must never come from the browser (a client
 * could send any org id it likes). For V1 (exactly one organization), this
 * is resolved from a trusted server-only env var instead.
 *
 * Multi-organization kiosk deployments (one Next.js deployment serving more
 * than one org's kiosk) are out of scope: that would need a trusted
 * device/location -> organization mapping resolved server-side, which is
 * not designed here.
 */
export function getKioskOrganizationId(): string {
  const organizationId = process.env.KIOSK_ORGANIZATION_ID;
  if (!organizationId) {
    throw new Error("KIOSK_ORGANIZATION_ID is not set");
  }
  return organizationId;
}
