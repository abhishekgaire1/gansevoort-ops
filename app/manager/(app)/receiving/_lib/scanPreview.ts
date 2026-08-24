import type { ScanErrorCode, FinalizePageInstruction } from "@/app/lib/scannerBridge/client";

/**
 * Pure, framework-agnostic helpers for the Scan Invoice preview step
 * (Direct Scanner Intake milestone, Part 12) -- extracted out of
 * ScanInvoiceFlow.tsx so the page-ordering/rotation/error-mapping logic
 * is directly unit-testable, matching this codebase's existing
 * convention (receivingPresentation.ts, cycleCountDisplayItems.ts) of
 * keeping pure logic separate from the component that renders it.
 */

export interface WorkingScanPage {
  sourceIndex: number;
  thumbnailDataUri: string;
  rotationDegrees: number;
}

/** Swaps a page with its neighbor in the given direction -- a no-op
 * (returns the same array reference) at either end, never wraps around. */
export function movePage(pages: WorkingScanPage[], index: number, direction: -1 | 1): WorkingScanPage[] {
  const target = index + direction;
  if (target < 0 || target >= pages.length || index < 0 || index >= pages.length) return pages;
  const next = [...pages];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function rotatePage(pages: WorkingScanPage[], index: number): WorkingScanPage[] {
  return pages.map((page, i) => (i === index ? { ...page, rotationDegrees: (page.rotationDegrees + 90) % 360 } : page));
}

export function deletePage(pages: WorkingScanPage[], index: number): WorkingScanPage[] {
  return pages.filter((_, i) => i !== index);
}

/** The array's OWN order at the moment of "Use Scan" IS the final page
 * order (Part 12) -- this just narrows each working page down to what
 * POST /jobs/:id/finalize actually needs (Part "MULTIPAGE NORMAL
 * INVOICES": one scan job assembles into ONE ordered PDF). */
export function buildFinalizeInstructions(pages: WorkingScanPage[]): FinalizePageInstruction[] {
  return pages.map((page) => ({ sourceIndex: page.sourceIndex, rotationDegrees: page.rotationDegrees }));
}

/** Manager-facing scan-failure copy -- never the raw ImageCaptureCore/
 * driver errorMessage (Part 23: "Do not expose ImageCaptureCore/native
 * error dumps directly to managers"), only this fixed mapping. */
export function scanErrorMessage(code: ScanErrorCode | null): string {
  switch (code) {
    case "NO_DOCUMENT_LOADED":
      return "No document detected in the feeder. Load a page and try again.";
    case "PAPER_JAM":
      return "The scanner reported a paper jam. Clear the feeder and try again.";
    case "SCANNER_BUSY":
      return "The scanner is busy with another job. Try again shortly.";
    case "SCANNER_OFFLINE":
      return "The scanner is offline. Check the connection and try again.";
    case "DEVICE_ERROR":
    case "TIMEOUT":
    case "INTERNAL_ERROR":
    case null:
    default:
      return "The scan could not be completed. Try again.";
  }
}
