import "server-only";
import { headers } from "next/headers";

/**
 * Identity + Access Management milestone -- the origin used for
 * password-reset/invitation email redirect links (Part 52: "Do not
 * hardcode localhost/production redirects. Use existing environment/
 * site URL conventions"). No NEXT_PUBLIC_SITE_URL or similar convention
 * exists anywhere in this project yet (checked before writing this),
 * so this derives the origin from the incoming request itself -- correct
 * automatically in both local dev and production without introducing a
 * new env var, and without ever guessing a hardcoded host.
 */
export async function resolveSiteOrigin(): Promise<string> {
  const headerList = await headers();
  const forwardedProto = headerList.get("x-forwarded-proto");
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  if (!host) {
    throw new Error("Unable to resolve the request host for a redirect URL");
  }
  const protocol = forwardedProto ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}
