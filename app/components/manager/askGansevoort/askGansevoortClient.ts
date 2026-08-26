import type { AskGansevoortResponse, ChatHistoryTurn } from "@/app/lib/ai/tasks/chat/contract";

/** Pure fetch-and-shape step behind the drawer's UI, extracted so
 * network/parse failures are directly unit-testable without rendering
 * the component -- same pattern as reportDownload.ts's fetchReportExport. */
export async function sendAskGansevoortQuestion(
  question: string,
  history: ChatHistoryTurn[],
  fetchImpl: typeof fetch = fetch
): Promise<AskGansevoortResponse> {
  try {
    const response = await fetchImpl("/api/manager/ask-gansevoort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history }),
    });
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object" && "ok" in body) {
      return body as AskGansevoortResponse;
    }
    return { ok: false, reason: "unexpected_error", message: "Something went wrong. Try again.", requestId: "" };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { ok: false, reason: "unexpected_error", message: "Request cancelled.", requestId: "" };
    }
    return { ok: false, reason: "unexpected_error", message: "Ask Gansevoort is temporarily unavailable. Try again shortly.", requestId: "" };
  }
}
