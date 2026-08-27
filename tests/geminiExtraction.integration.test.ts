import { describe, expect, it } from "vitest";
import { GeminiProvider } from "@/app/lib/ai/providers/gemini";
import { extractInvoiceRaw } from "@/app/lib/ai/tasks/invoiceExtraction/extract";
import { normalizeInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/normalize";
import { validateInvoiceExtraction } from "@/app/lib/ai/tasks/invoiceExtraction/validate";

/**
 * MANUAL / ON-DEMAND ONLY -- not run in CI or by `npm test`. Run explicitly
 * via `npm run test:gemini`, and only when GEMINI_API_KEY is set (skipped,
 * not failed, otherwise). Makes a real, paid call to the Gemini API.
 *
 * This exercises real end-to-end plumbing (auth, structured-output schema
 * enforcement, our schema/normalize/validate pipeline) using a fabricated
 * invoice description as a text part -- it is a connectivity/pipeline
 * smoke test, not an extraction-quality benchmark. Real document/image
 * quality testing happens through the dev test harness
 * (app/manager/ai-test/invoice), against real invoices, per the plan.
 */

const apiKey = process.env.GEMINI_API_KEY;

describe.skipIf(!apiKey)("Gemini invoice extraction (live API)", () => {
  it("extracts a fabricated invoice description into schema-conforming, sensible structured data", async () => {
    const provider = new GeminiProvider(apiKey!);

    const sampleInvoiceText = `
INVOICE

Baldor Specialty Foods
123 Produce Ave, Bronx NY

Invoice #: B-839291
Invoice Date: 08/12/2026

Line items:
5 CS   87.4 LB   $1.49/LB   $130.23   TOM ROMA XL 25LB   SKU TOM-25
2 BOX  $37.00 BOX  $74.00   Eggs Large Grade A   SKU EGG-360

Subtotal: $204.23
Tax: $0.00
Total: $204.23
`.trim();

    const result = await extractInvoiceRaw(provider, {
      files: [
        {
          bytesBase64: Buffer.from(sampleInvoiceText, "utf-8").toString("base64"),
          // Gemini does not accept plain text as an inline file part in the
          // same way as an image/PDF; this smoke test sends it as a minimal
          // "text file" so the multimodal file-input path is still exercised.
          mimeType: "text/plain",
        },
      ],
    });

    const normalized = normalizeInvoiceExtraction(result.data);
    const { issues } = validateInvoiceExtraction(normalized);

    expect(normalized.vendorName).toBeTruthy();
    expect(normalized.invoiceNumber).toBeTruthy();
    expect(normalized.lines.length).toBeGreaterThan(0);

    // The core "don't collapse package count and measured weight" guarantee,
    // checked against a REAL model response rather than a mock.
    const catchWeightLine = normalized.lines.find((line) => line.measuredQuantity !== null);
    expect(catchWeightLine).toBeDefined();
    expect(catchWeightLine?.packageQuantity).not.toBeNull();

    // Deliberate: this manual test's whole purpose is to let a human
    // inspect a real model response.
    console.log("Normalized extraction:", JSON.stringify(normalized, null, 2));
    console.log("Review flags:", JSON.stringify(issues, null, 2));
  }, 60_000);
});
