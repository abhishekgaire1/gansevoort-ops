"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { sendAskGansevoortQuestion } from "./askGansevoortClient";
import { fetchChatDownload } from "./chatDownload";
import { ASK_GANSEVOORT_SUGGESTED_QUESTIONS, canSubmitQuestion, trimChatHistory } from "@/app/lib/ai/tasks/chat/uiHelpers";
import type { ChatDownload, ChatEvidence, ChatHistoryTurn } from "@/app/lib/ai/tasks/chat/contract";
import { useAskGansevoortDensity } from "@/app/components/manager/askGansevoort/AskGansevoortDensityContext";

/**
 * Manager-only entry point (Section 16). Rendered ONLY from
 * ManagerShell.tsx, which wraps app/manager/(app)/ routes exclusively --
 * the kiosk has its own separate, unrelated layout (app/kiosk/layout.tsx)
 * that never imports this component, so it is structurally impossible
 * for the button to appear there.
 *
 * No markdown-rendering dependency exists in this repo and none is added
 * for this feature (Section 16) -- answers render as plain text with
 * paragraph breaks only, never dangerouslySetInnerHTML.
 */

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
  evidence?: ChatEvidence[];
  downloads?: ChatDownload[];
  warning?: string | null;
  isError?: boolean;
}

export function AskGansevoortLauncher() {
  const density = useAskGansevoortDensity();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else triggerRef.current?.focus();
  }, [open]);

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [messages, inFlight]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>('button, textarea, a[href], [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  async function submitQuestion(question: string) {
    if (!canSubmitQuestion(question, inFlight)) return;
    setInput("");
    setInFlight(true);
    setMessages((prev) => [...prev, { role: "user", content: question }]);

    const history: ChatHistoryTurn[] = trimChatHistory(messages.map((m) => ({ role: m.role, content: m.content })));
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const response = await sendAskGansevoortQuestion(question, history, (input, init) => fetch(input, { ...init, signal: controller.signal }));
    abortControllerRef.current = null;
    setInFlight(false);

    if (response.ok) {
      setMessages((prev) => [...prev, { role: "assistant", content: response.answer, evidence: response.evidence, downloads: response.downloads, warning: response.warning }]);
    } else {
      setMessages((prev) => [...prev, { role: "assistant", content: response.message, isError: true }]);
    }
  }

  function handleCancel() {
    abortControllerRef.current?.abort();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Ask Gansevoort"
        title="Ask Gansevoort"
        className={
          density === "compact"
            ? "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-40 flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs font-medium text-zinc-300 shadow-md hover:border-zinc-600 hover:text-zinc-100"
            : "fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] right-5 z-40 flex items-center gap-2 rounded-full bg-amber-400 px-4 py-3 text-sm font-semibold text-zinc-950 shadow-lg hover:bg-amber-300"
        }
      >
        <ChatIcon />
        {density === "compact" ? null : "Ask Gansevoort"}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button type="button" aria-label="Close Ask Gansevoort" className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ask-gansevoort-title"
            className="relative z-10 flex h-full w-full flex-col border-l border-zinc-800 bg-zinc-950 pb-[env(safe-area-inset-bottom)] sm:w-[440px]"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
              <h2 id="ask-gansevoort-title" className="text-sm font-semibold text-zinc-100">
                Ask Gansevoort
              </h2>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setMessages([])} className="text-xs text-zinc-400 underline hover:text-zinc-200">
                  New conversation
                </button>
                <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
                  <CloseIcon />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4">
              {messages.length === 0 ? (
                <EmptyState onPick={submitQuestion} />
              ) : (
                <div className="flex flex-col gap-3">
                  {messages.map((message, index) => (
                    <MessageBubble key={index} message={message} />
                  ))}
                  {inFlight ? <p className="text-xs text-zinc-500">Thinking…</p> : null}
                  <div ref={scrollAnchorRef} />
                </div>
              )}
            </div>

            <div className="border-t border-zinc-800 p-3">
              <p className="mb-2 text-[11px] text-zinc-500">AI can make mistakes. Verify important decisions using the cited records.</p>
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submitQuestion(input.trim());
                    }
                  }}
                  rows={2}
                  maxLength={1000}
                  placeholder="Ask about inventory, purchasing, usage, waste…"
                  className="min-w-0 flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
                />
                {inFlight ? (
                  <button type="button" onClick={handleCancel} className="shrink-0 rounded-xl border border-zinc-700 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-900">
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => submitQuestion(input.trim())}
                    disabled={!canSubmitQuestion(input, inFlight)}
                    className="shrink-0 rounded-xl bg-amber-400 px-4 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-40"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function EmptyState({ onPick }: { onPick: (question: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-400">
        Ask about current inventory, purchasing, receiving, usage, waste, cycle counts, or Inventory Alerts. Ask Gansevoort only explains data that already
        exists -- it cannot make changes.
      </p>
      <div className="flex flex-col gap-2">
        {ASK_GANSEVOORT_SUGGESTED_QUESTIONS.map((question) => (
          <button
            key={question}
            type="button"
            onClick={() => onPick(question)}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-left text-sm text-zinc-200 hover:border-zinc-700"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[90%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
          isUser ? "bg-amber-400 text-zinc-950" : message.isError ? "border border-red-900/60 bg-red-950/20 text-red-200" : "bg-zinc-900 text-zinc-100"
        }`}
      >
        {message.content}
      </div>
      {message.warning ? <p className="max-w-[90%] text-xs text-amber-400">{message.warning}</p> : null}
      {message.evidence && message.evidence.length > 0 ? (
        <div className="flex max-w-[90%] flex-col gap-1.5">
          {message.evidence.map((evidence) => (
            <Link
              key={evidence.id}
              href={evidence.href}
              className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-300 hover:border-zinc-700"
            >
              <span className="font-medium text-zinc-100">{evidence.label}</span>
              {evidence.period ? (
                <span className="ml-2 text-zinc-500">
                  {evidence.period.startDate} – {evidence.period.endDate}
                </span>
              ) : null}
              {evidence.asOf ? <span className="ml-2 text-zinc-500">as of {new Date(evidence.asOf).toLocaleString()}</span> : null}
            </Link>
          ))}
        </div>
      ) : null}
      {message.downloads && message.downloads.length > 0 ? (
        <div className="flex max-w-[90%] flex-col gap-1.5">
          {message.downloads.map((download, index) => (
            <DownloadButton key={`${download.reportSpecification.reportId}-${index}`} download={download} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DownloadButton({ download }: { download: ChatDownload }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (pending) return; // duplicate-click prevention while a download is already in flight
    setError(null);
    setPending(true);
    const fallbackFilename = `${download.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${download.format}`;
    const result = await fetchChatDownload(download.reportSpecification, fallbackFilename);
    if (!result.ok) {
      // Inline error only -- the conversation above is never touched.
      setError("Could not download the report. Try again.");
    } else {
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }
    setPending(false);
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="flex items-center gap-2 rounded-xl border border-amber-400/60 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-400/20 disabled:opacity-60"
      >
        <DownloadIcon />
        {pending ? "Preparing download…" : `${download.label} (.${download.format})`}
      </button>
      {error ? <p className="mt-1 text-[11px] text-red-400">{error}</p> : null}
    </div>
  );
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12m0 0-4-4m4 4 4-4M4 19h16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
