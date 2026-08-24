/**
 * AI Configuration + Usage/Cost Tracking milestone -- the ONLY place an AI
 * task identifier is allowed to appear as a literal string, mirroring the
 * existing convention in app/lib/ai/config.ts for model names. Task keys
 * are application capabilities, not user-created data: an Admin can assign
 * a provider/model to a task key, but can never invent a new one.
 *
 * These are the ACTUAL AI call sites found in this codebase (Phase A
 * inspection) -- not a hypothetical taxonomy:
 *
 * - INVOICE_EXTRACTION: app/lib/ai/tasks/invoiceExtraction (one Gemini
 *   call per document, extracts header/lines from an uploaded invoice).
 *
 * - ITEM_CLASSIFICATION: app/lib/ai/tasks/itemClassification (one batched
 *   Gemini call per unresolved-lines run). Deliberately a SINGLE task key
 *   even though its structured output covers several concerns a product
 *   spec might describe separately -- canonical item matching
 *   (candidateItemId), new canonical item proposal (proposedName + its
 *   fields), inventory category suggestion (suggestedInventoryCategoryId),
 *   and spend category suggestion (suggestedSpendCategoryId) are ALL
 *   produced by this one physical AI call against one shared candidate
 *   context (see classifyPurchaseDocumentLines.ts). Splitting these into
 *   independently-configurable task keys would let an Admin pick "Model A
 *   for item matching, Model B for new-item suggestions" -- a control that
 *   doesn't correspond to anything the system can actually do, since it's
 *   one request. Vendor matching is NOT AI-assisted anywhere in this
 *   codebase (fully deterministic alias/mapping resolution, or manual
 *   Manager quick-create -- see the Admin Master Data milestone) so it is
 *   not a task key at all.
 *
 * - CHAT: reserved, not yet implemented anywhere. Shown in the Admin UI as
 *   "Not configured yet" per the milestone spec's own example -- never
 *   selectable.
 *
 * - CONFIGURATION_TEST: not a real business capability and never
 *   Admin-configurable (there is no "default model for testing" concept --
 *   Test Configuration always exercises whatever provider/model is
 *   currently being tested). Exists purely so its usage/cost is
 *   distinguishable from operational usage in the Usage & Cost view.
 */
export const AI_TASK_KEYS = ["INVOICE_EXTRACTION", "ITEM_CLASSIFICATION", "CHAT"] as const;
export type AITaskKey = (typeof AI_TASK_KEYS)[number];

/** Not a real task, never configurable -- see CONFIGURATION_TEST above.
 * Kept out of AI_TASK_KEYS/AITaskKey so it can never be assigned a
 * provider/model override, but shares the same underlying usage-event
 * "task_key" column and the same CHECK constraint set in the migration. */
export const CONFIGURATION_TEST_TASK_KEY = "CONFIGURATION_TEST" as const;

export type AIUsageTaskKey = AITaskKey | typeof CONFIGURATION_TEST_TASK_KEY;

export const AI_TASK_LABELS: Record<AITaskKey, string> = {
  INVOICE_EXTRACTION: "Invoice Extraction",
  ITEM_CLASSIFICATION: "Item Classification & Matching",
  CHAT: "AI Chatbot",
};

export const AI_TASK_DESCRIPTIONS: Record<AITaskKey, string> = {
  INVOICE_EXTRACTION: "Reads an uploaded invoice/receipt and extracts vendor, line items, and totals for Receiving.",
  ITEM_CLASSIFICATION:
    "Matches invoice lines to existing canonical items, proposes new items, and suggests inventory/spend categories -- one combined step per receiving line.",
  CHAT: "Not configured yet.",
};

/** Tasks an Admin can actually assign a provider/model to. CHAT is listed
 * in the UI (Part 4's mockup explicitly shows it as "Not configured yet")
 * but is never selectable -- there is no implementation to route to. */
export const CONFIGURABLE_AI_TASK_KEYS: AITaskKey[] = ["INVOICE_EXTRACTION", "ITEM_CLASSIFICATION"];

export const AI_USAGE_TASK_LABELS: Record<AIUsageTaskKey, string> = {
  ...AI_TASK_LABELS,
  CONFIGURATION_TEST: "Configuration Tests",
};

export function isAITaskKey(value: string): value is AITaskKey {
  return (AI_TASK_KEYS as readonly string[]).includes(value);
}
