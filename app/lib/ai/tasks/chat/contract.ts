import type { ResolvedReportSpecification } from "@/app/lib/reports/registry/types";

/**
 * Ask Gansevoort -- the request/response contract between the manager-only
 * chat UI (client) and the /api/manager/ask-gansevoort route (server).
 *
 * Deliberately NOT "server-only": the client drawer needs these plain
 * types to build its request and render its response. No zod schemas live
 * here (those are server-only validation, in toolRegistry.ts/schema.ts) --
 * this file is types only, safe for the client bundle.
 */

export const ASK_GANSEVOORT_MAX_QUESTION_LENGTH = 1000;
/** Turns (one manager question + one assistant answer) kept in the
 * in-tab conversation and sent back with each request -- bounds both the
 * request body size and how much prior context the model has to read. */
export const ASK_GANSEVOORT_MAX_HISTORY_TURNS = 6;

export type ChatRole = "user" | "assistant";

export interface ChatHistoryTurn {
  role: ChatRole;
  content: string;
}

export interface AskGansevoortRequestBody {
  question: string;
  history: ChatHistoryTurn[];
}

/** Allowlisted evidence source types -- the ONLY values entityHref-style
 * routing will ever be built from. Never an arbitrary model-supplied
 * string. */
export const EVIDENCE_SOURCE_TYPES = [
  "inventory_status",
  "purchasing_report",
  "receiving_report",
  "usage_report",
  "waste_report",
  "cycle_count",
  "inventory_alert",
  "reports_overview",
  "item_detail",
  "purchase_document",
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export interface ChatEvidence {
  id: string;
  label: string;
  sourceType: EvidenceSourceType;
  sourceId: string | null;
  href: string;
  period: { startDate: string; endDate: string } | null;
  asOf: string | null;
}

export const CHAT_TOOL_NAMES = [
  "get_inventory_status",
  "get_purchasing_summary",
  "get_receiving_summary",
  "get_usage_summary",
  "get_waste_summary",
  "get_cycle_count_summary",
  "get_inventory_alerts",
  "get_reports_overview",
  "get_item_purchase_cost",
  "prepare_report_export",
] as const;
export type ChatToolName = (typeof CHAT_TOOL_NAMES)[number];

/** A server-prepared, trusted download descriptor (Section 7/8/10) -- the
 * model never constructs `reportSpecification` itself; it only ever sees
 * and summarizes the dataText a tool returned. `reportSpecification` is
 * the fully resolved, server-validated request -- the client sends it
 * back UNCHANGED to the download route, which treats it as a REQUEST,
 * never as authorization, and independently re-derives/re-validates
 * everything (organization, report id, dates, filters, columns) before
 * generating anything. */
export interface ChatDownload {
  label: string;
  format: "xlsx";
  reportSpecification: ResolvedReportSpecification;
}

export interface AskGansevoortResolvedPeriod {
  key: "TODAY" | "7D" | "30D" | "N/A";
  startDate: string;
  endDate: string;
}

export type AskGansevoortSuccessResponse = {
  ok: true;
  answer: string;
  evidence: ChatEvidence[];
  period: AskGansevoortResolvedPeriod | null;
  toolsUsed: ChatToolName[];
  generatedAt: string;
  warning: string | null;
  requestId: string;
  downloads: ChatDownload[];
};

export type AskGansevoortFailureReason =
  | "not_authenticated"
  | "not_authorized"
  | "invalid_request"
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "unexpected_error";

export type AskGansevoortFailureResponse = {
  ok: false;
  reason: AskGansevoortFailureReason;
  message: string;
  retryAfterSeconds?: number;
  requestId: string;
};

export type AskGansevoortResponse = AskGansevoortSuccessResponse | AskGansevoortFailureResponse;

export const ASK_GANSEVOORT_ACTION_REFUSAL = "Ask Gansevoort can explain your operational data, but it cannot make changes.";
export const ASK_GANSEVOORT_INSUFFICIENT_DATA = "I don't have enough verified data to answer that confidently.";
