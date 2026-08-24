import { redirect } from "next/navigation";
import { requireAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { getAIOrganizationConfiguration } from "@/app/lib/ai/admin";
import { getAIUsageReport } from "@/app/lib/ai/usage";
import { resolveOrganizationTimezone } from "@/app/lib/dateRanges/organizationTimezone";
import { todayRange } from "@/app/lib/dateRanges/calendarPeriods";
import { AI_MODELS, AI_PROVIDERS } from "@/app/lib/ai/models";
import { isProviderConfigured } from "@/app/lib/ai/router/providerRegistry";
import { PageHeader } from "@/app/components/manager/PageHeader";
import { AIConfigurationTabs } from "./_components/AIConfigurationTabs";

/**
 * Admin -> AI Configuration (AI Configuration + Usage/Cost Tracking
 * milestone) -- the centralized control layer for AI provider/model
 * decisions across the whole app. Server-enforces requireAdmin() itself
 * (Part 3) -- a Manager hitting this route directly is redirected, never
 * merely hidden from the sidebar.
 */
export const dynamic = "force-dynamic";

export default async function AdminAIPage() {
  const auth = await requireAdmin();
  if (!auth.ok) {
    redirect(auth.reason === "not_authenticated" ? "/manager/login" : "/manager");
  }

  const supabase = getServiceRoleClient();
  const timezone = await resolveOrganizationTimezone(supabase, auth.manager.organizationId);
  const todaysRange = todayRange(new Date(), timezone);

  const [configuration, initialUsageReport] = await Promise.all([
    getAIOrganizationConfiguration(supabase, auth.manager.organizationId),
    getAIUsageReport(supabase, auth.manager.organizationId, todaysRange.start, todaysRange.end),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="AI Configuration" description="Configure the approved AI services used by Gansevoort Ops." />
      <AIConfigurationTabs
        initialConfiguration={configuration}
        providers={Object.values(AI_PROVIDERS).map((p) => ({ key: p.key, displayName: p.displayName, connected: isProviderConfigured(p.key) }))}
        models={AI_MODELS.filter((m) => m.enabled).map((m) => ({ provider: m.provider, modelId: m.modelId, displayName: m.displayName, recommendedFor: m.recommendedFor }))}
        initialUsageReport={initialUsageReport}
      />
    </div>
  );
}
