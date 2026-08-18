import type { ReviewFlag, ReviewFlagSeverity } from "@/app/lib/ai/tasks/invoiceExtraction/types";

/**
 * Turns a ReviewFlag (a stable machine code + an already-reasonable
 * message, e.g. { code: "LINE_MISSING_PACKAGE_UNIT", field: "lines[0].packageUnit",
 * message: "Line 1 has a package quantity but no package unit." }) into
 * manager-facing text. The underlying `message` strings are already full
 * sentences -- what was actually leaking a developer string to managers was
 * the OLD display format that prefixed every flag with "[severity] CODE
 * (field):". This never invents new copy for a code it doesn't recognize;
 * it falls back to the flag's own message untouched, so nothing is ever
 * silently hidden.
 */

export interface TranslatedReviewFlag {
  severity: ReviewFlagSeverity;
  text: string;
  /** 0-indexed line this flag is about, parsed from a "lines[N]..." field
   * path, or null for a header-level flag. */
  lineIndex: number | null;
}

const LINE_CODE_PHRASE: Record<string, string> = {
  LINE_MISSING_DESCRIPTION: "description could not be identified.",
  LINE_MISSING_PACKAGE_UNIT: "invoice quantity unit could not be identified.",
  LINE_MISSING_MEASURED_UNIT: "measured quantity unit could not be identified.",
  LINE_NEGATIVE_PACKAGE_QUANTITY: "package quantity looks invalid (negative).",
  LINE_NEGATIVE_MEASURED_QUANTITY: "measured quantity looks invalid (negative).",
  LINE_NEGATIVE_UNIT_PRICE: "unit price looks invalid (negative).",
  LINE_NEGATIVE_TOTAL: "line total looks invalid (negative).",
  LINE_TOTAL_MISMATCH: "line total doesn't match quantity × price.",
};

const LINE_FIELD_PATTERN = /^lines\[(\d+)\]/;

/** `lines` only needs each line's own description, to build "{description}
 * — {reason}" instead of a bare "Line N — {reason}" when one exists. */
export function translateReviewFlags(flags: ReviewFlag[], lines: { description: string | null }[]): TranslatedReviewFlag[] {
  return flags.map((flag) => {
    const match = flag.field ? LINE_FIELD_PATTERN.exec(flag.field) : null;
    const lineIndex = match ? Number(match[1]) : null;

    if (lineIndex === null) {
      return { severity: flag.severity, text: flag.message, lineIndex: null };
    }

    const phrase = LINE_CODE_PHRASE[flag.code];
    const label = lines[lineIndex]?.description?.trim() || `Line ${lineIndex + 1}`;
    return {
      severity: flag.severity,
      text: phrase ? `${label} — ${phrase}` : flag.message,
      lineIndex,
    };
  });
}
