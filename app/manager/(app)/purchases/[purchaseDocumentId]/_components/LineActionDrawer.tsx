"use client";

/**
 * LineActionDrawer -- one reusable right-side drawer for every per-line
 * correction on a purchase document. It is deliberately presentational: the
 * caller supplies which of the four scopes apply and the section bodies to
 * render; the drawer only owns chrome (portal, focus trap, ESC/backdrop close
 * with an unsaved-change guard, and a full-screen sheet on narrow screens).
 *
 * The four scopes it can present, in order, each an optional disclosure so a
 * line only shows the ones that apply:
 *   A -- Correct this invoice only   (receiving / invoice-unit corrections)
 *   B -- Update vendor purchase package
 *   C -- Review price change
 *   D -- Edit registered item safely (Item Workspace handoff)
 *
 * It never posts, never mutates data itself, and never changes a protected
 * field -- the bodies passed in own all of that.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LineActionScope } from "@/app/lib/purchaseDocuments/lineBulkAndDrawer";

export type { LineActionScope };

export type LineActionSection = {
  scope: LineActionScope;
  /** Short heading shown in the disclosure summary. */
  title: string;
  /** One-line description of what this scope changes and how far it reaches. */
  blurb: string;
  /** Optional right-aligned status pill (e.g. "Needs review"). */
  status?: ReactNode;
  body: ReactNode;
  /** When true the disclosure starts expanded (e.g. the reason the line was opened). */
  defaultOpen?: boolean;
};

const SCOPE_LABEL: Record<LineActionScope, string> = {
  "correct-invoice": "Correct this invoice only",
  "vendor-package": "Update vendor purchase package",
  "price-change": "Review price change",
  "registered-item": "Edit registered item safely",
};

const SCOPE_REACH: Record<LineActionScope, string> = {
  "correct-invoice": "Affects only this invoice.",
  "vendor-package": "Updates the vendor's saved package — affects future invoices from this vendor.",
  "price-change": "Records your acknowledgment for this line. No item or price data is overwritten.",
  "registered-item": "Opens the registered item — changes reach every document using it.",
};

function Disclosure({ section }: { section: LineActionSection }) {
  const [open, setOpen] = useState<boolean>(section.defaultOpen ?? false);
  const panelId = useId();
  return (
    <div className="border-b border-zinc-800 last:border-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-zinc-900/40"
      >
        <span aria-hidden className={`mt-0.5 shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-zinc-100">{SCOPE_LABEL[section.scope]}</span>
            {section.status ?? null}
          </span>
          <span className="mt-0.5 block text-xs text-zinc-400">{section.blurb}</span>
          <span className="mt-0.5 block text-[11px] italic text-zinc-500">{SCOPE_REACH[section.scope]}</span>
        </span>
      </button>
      {open ? (
        <div id={panelId} className="px-4 pb-4">
          {section.body}
        </div>
      ) : null}
    </div>
  );
}

export function LineActionDrawer({
  open,
  title,
  subtitle,
  sections,
  scopes,
  issues,
  onPrev,
  onNext,
  navLabel,
  dirty,
  onRequestClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  /** Disclosure sections; when omitted, `children` is rendered as the body. */
  sections?: LineActionSection[];
  /** The scopes this line involves -- shown as a legend above a custom body. */
  scopes?: LineActionScope[];
  /** Full, untruncated blocking-issue text(s) shown at the top of the drawer. */
  issues?: string[];
  /** Previous/next unresolved-line navigation (shown only when both given). */
  onPrev?: () => void;
  onNext?: () => void;
  navLabel?: string;
  /** True while an in-drawer edit form has unsaved local input. */
  dirty: boolean;
  onRequestClose: () => void;
  children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const labelId = useId();

  const attemptClose = useCallback(() => {
    if (dirty && !window.confirm("Discard unsaved changes on this line?")) return;
    onRequestClose();
  }, [dirty, onRequestClose]);

  // Focus trap + ESC. Move focus into the panel on open and keep Tab cycling
  // inside it; restore focus to the previously focused element on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // Focus the first actionable field in the correction surface (so a manager
    // lands on what to fix), falling back to the panel itself.
    const firstField = bodyRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
    );
    (firstField ?? panel)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        attemptClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open, attemptClose]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/60" onClick={attemptClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        tabIndex={-1}
        className="relative ml-auto flex h-full w-full flex-col border-l border-zinc-700 bg-zinc-950 shadow-2xl focus:outline-none sm:max-w-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3.5">
          <div className="min-w-0">
            <h2 id={labelId} className="truncate text-sm font-semibold text-zinc-100">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 truncate text-xs text-zinc-400">{subtitle}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onPrev || onNext ? (
              <div className="flex items-center gap-1">
                <button type="button" onClick={onPrev} disabled={!onPrev} aria-label="Previous issue" className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40">
                  ‹ Prev
                </button>
                {navLabel ? <span className="whitespace-nowrap text-[11px] text-zinc-400">{navLabel}</span> : null}
                <button type="button" onClick={onNext} disabled={!onNext} aria-label="Next issue" className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-40">
                  Next ›
                </button>
              </div>
            ) : null}
            <button
              type="button"
              onClick={attemptClose}
              aria-label="Close"
              className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-200 hover:bg-zinc-900"
            >
              Close
            </button>
          </div>
        </div>
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto">
          {issues && issues.length > 0 ? (
            <div className="border-b border-amber-800/60 bg-amber-950/20 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-300">
                {issues.length > 1 ? "Issues to resolve" : "Issue to resolve"}
              </p>
              <ul className="mt-1 space-y-1">
                {issues.map((issue, i) => (
                  // Full error text -- never truncated (no line-clamp / truncate).
                  <li key={i} className="text-sm leading-snug text-amber-100">
                    {issue}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {scopes && scopes.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 border-b border-zinc-800 px-4 py-2.5">
              {scopes.map((s) => (
                <span key={s} className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300">
                  {SCOPE_LABEL[s]}
                </span>
              ))}
            </div>
          ) : null}
          {sections && sections.length > 0 ? (
            sections.map((section) => <Disclosure key={section.scope} section={section} />)
          ) : children ? (
            children
          ) : (
            <p className="px-4 py-6 text-sm text-zinc-400">No corrections are available for this line.</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
