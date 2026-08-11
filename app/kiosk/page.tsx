import { KioskApp } from "./_components/KioskApp";

/**
 * No per-request personalization is possible before PIN entry (the kiosk
 * organization is a fixed server env var, no cookies/session to read), so
 * this stays a trivial Server Component by default convention. All state
 * and every Server Action call live inside <KioskApp />, a Client
 * Component -- see app/kiosk/_lib/kioskReducer.ts for why the whole flow
 * has to be one client-side tree.
 */
export default function KioskPage() {
  return <KioskApp />;
}
