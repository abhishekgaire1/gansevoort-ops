"use server";

import { after } from "next/server";
import { requireManagerOrAdmin } from "@/app/lib/auth/managerAuth";
import { getServiceRoleClient } from "@/app/lib/supabase/serviceClient";
import { runDocumentExtractionAttempt } from "@/app/lib/documents/runDocumentExtractionAttempt";
import { resolveAIConfig } from "@/app/lib/ai/router/resolveAIConfig";
import { isAttemptStale } from "@/app/lib/documents/staleExtraction";

export type RetryExtractionResult =
  | { ok: true; attemptId: string }
  | { ok: false; reason: "not_authorized" | "not_found" | "already_in_progress" | "misconfigured"; message: string };

/**
 * Retry always inserts a NEW attempt row -- never mutates a prior attempt's
 * result in place (enforced at the DB level by the transition-guard
 * trigger once an attempt is terminal). If the current latest attempt is
 * still PENDING/RUNNING but has exceeded the stale threshold, this
 * terminalizes it to FAILED/TIMED_OUT first; a genuinely in-progress
 * (non-stale) attempt is left alone and this returns an error instead --
 * the disable-on-click UI guard is only a convenience, this check plus the
 * DB's partial unique index (document_extractions_one_active_per_document)
 * is what actually prevents two active attempts.
 */
export async function retryDocumentExtraction(documentId: string): Promise<RetryExtractionResult> {
  const auth = await requireManagerOrAdmin();
  if (!auth.ok) {
    return { ok: false, reason: "not_authorized", message: "You must be signed in as a manager or admin." };
  }

  const serviceClient = getServiceRoleClient();

  const { data: document, error: documentError } = await serviceClient
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .eq("organization_id", auth.manager.organizationId)
    .maybeSingle();

  if (documentError || !document) {
    return { ok: false, reason: "not_found", message: "Document not found." };
  }

  const { data: latestAttempt } = await serviceClient
    .from("document_extractions")
    .select("id, attempt_number, status, requested_at, started_at")
    .eq("document_id", documentId)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestAttempt && (latestAttempt.status === "PENDING" || latestAttempt.status === "RUNNING")) {
    const stale = isAttemptStale({
      status: latestAttempt.status,
      requestedAt: latestAttempt.requested_at,
      startedAt: latestAttempt.started_at,
    });

    if (!stale) {
      return { ok: false, reason: "already_in_progress", message: "Extraction is already in progress." };
    }

    // Conditioned on its current status: if the real executor completes
    // between our read above and this UPDATE, this affects zero rows and
    // the insert below is correctly rejected by the DB instead.
    await serviceClient
      .from("document_extractions")
      .update({
        status: "FAILED",
        completed_at: new Date().toISOString(),
        error_code: "TIMED_OUT",
        error_message: "Extraction did not complete within the expected time and was marked failed on retry.",
      })
      .eq("id", latestAttempt.id)
      .eq("status", latestAttempt.status);
  }

  const nextAttemptNumber = (latestAttempt?.attempt_number ?? 0) + 1;

  // AI Configuration milestone: resolved fresh for this retry (task
  // override -> org default -> app default) -- if an Admin changed the
  // configured model since the original attempt, a manual retry
  // deliberately picks up the new one; the original attempt's own row is
  // never rewritten (Part 49).
  const aiConfig = await resolveAIConfig(serviceClient, auth.manager.organizationId, "INVOICE_EXTRACTION");

  const { data: newAttempt, error: insertError } = await serviceClient
    .from("document_extractions")
    .insert({
      organization_id: auth.manager.organizationId,
      document_id: documentId,
      attempt_number: nextAttemptNumber,
      provider: aiConfig.provider,
      model: aiConfig.model,
      status: "PENDING",
    })
    .select("id")
    .single();

  if (insertError || !newAttempt) {
    return { ok: false, reason: "already_in_progress", message: "Extraction is already in progress." };
  }

  after(() => runDocumentExtractionAttempt(newAttempt.id));

  return { ok: true, attemptId: newAttempt.id };
}
