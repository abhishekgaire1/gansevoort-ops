import { notFound } from "next/navigation";
import { UploadAndExtract } from "./_components/UploadAndExtract";

/**
 * TEMPORARY development test harness for invoice extraction quality --
 * NOT the real receiving UI (that doesn't exist yet). Every "Extract with
 * Gemini" click makes a real, paid API call, so this route requires
 * BOTH an explicit opt-in env flag AND a non-production environment --
 * this is not authentication, only a guard against an accidentally-exposed,
 * real-money endpoint. There is no manager login system yet (Milestone
 * 2A.0 deliberately doesn't build one); building real auth just to gate a
 * throwaway dev harness would be its own scope creep.
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
