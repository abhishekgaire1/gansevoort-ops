import { notFound } from "next/navigation";
import { UploadAndExtract } from "./_components/UploadAndExtract";

/**
 * TEMPORARY development test harness for invoice extraction quality/model
 * comparison -- NOT the receiving UI (see /manager/receiving). Every
 * "Extract with Gemini" click makes a real, paid API call, so this route
 * still requires BOTH an explicit opt-in env flag AND a non-production
 * environment on top of (not instead of) now living inside the
 * app/manager/(app)/ route group, which means requireManagerOrAdmin() also
 * gates it via the shared layout -- belt-and-suspenders: the env gate keeps
 * it unreachable in any real deployment regardless of who's signed in, and
 * the auth gate keeps a non-manager authenticated user out of it in a
 * dev/staging environment where the flag happens to be on.
 *
 * Forced dynamic: without this, Next.js would statically prerender the
 * page at `next build` time and bake in whatever env vars happened to be
 * present then, rather than re-checking them on every request.
 */
export const dynamic = "force-dynamic";

export default function AiTestInvoicePage() {
  const isProduction = process.env.NODE_ENV === "production";
  const isEnabled = process.env.ALLOW_AI_TEST_PAGE === "true";

  if (isProduction || !isEnabled) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-50">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold">Invoice Extraction Test Harness</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Development-only extraction quality inspector. Not the receiving UI. Nothing here is saved anywhere.
        </p>
        <UploadAndExtract />
      </div>
    </div>
  );
}
