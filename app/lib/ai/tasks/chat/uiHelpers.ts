import { ASK_GANSEVOORT_MAX_HISTORY_TURNS, type ChatHistoryTurn } from "@/app/lib/ai/tasks/chat/contract";

/** Pure UI-logic helpers, extracted so they're directly unit-testable
 * without rendering the drawer component (no React Testing Library
 * dependency exists in this repo -- see package.json devDependencies). */

export const ASK_GANSEVOORT_SUGGESTED_QUESTIONS: string[] = [
  "Which inventory items are low right now?",
  "Which stations used the most inventory this week?",
  "What were the top waste items this month?",
  "Show recent high-withdrawal alerts.",
];

/** Keeps only the most recent N turns -- bounds both the request body
 * size and how much prior context the model has to read (Section 9's
 * "maximum history size"). Oldest turns are dropped first. */
export function trimChatHistory(history: ChatHistoryTurn[], maxTurns: number = ASK_GANSEVOORT_MAX_HISTORY_TURNS): ChatHistoryTurn[] {
  if (history.length <= maxTurns) return history;
  return history.slice(history.length - maxTurns);
}

/** Duplicate-send guard: a question can be submitted only when non-blank
 * and no request is already in flight for this chat panel (Section 9's
 * "one active request per chat panel"). */
export function canSubmitQuestion(question: string, isRequestInFlight: boolean): boolean {
  return question.trim().length > 0 && !isRequestInFlight;
}
