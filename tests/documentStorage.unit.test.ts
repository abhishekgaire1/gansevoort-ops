import { describe, expect, it } from "vitest";
import { buildStoragePath } from "@/app/lib/documents/storagePath";
import { ACCEPTED_MIME_TYPES, extensionForMimeType, sniffMimeType } from "@/app/lib/files/sniffMimeType";
import { buildArchiveFilename } from "@/app/lib/documents/archiveFilename";

describe("buildStoragePath", () => {
  it("builds a stable path with no vendor/date/invoice-number component", () => {
    expect(buildStoragePath("org-1", "doc-1", "pdf")).toBe("org/org-1/documents/doc-1/original.pdf");
  });

  it("takes no parameter through which extracted metadata could steer the path", () => {
    // The function signature itself has no such parameter -- this test
    // documents that constraint rather than exercising it dynamically.
    expect(buildStoragePath.length).toBe(3);
  });
});

describe("extensionForMimeType", () => {
  it("maps every accepted MIME type to an extension", () => {
    expect(extensionForMimeType("application/pdf")).toBe("pdf");
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("image/png")).toBe("png");
  });

  it("throws for an unsupported MIME type", () => {
    expect(() => extensionForMimeType("image/heic")).toThrow();
  });
});

describe("sniffMimeType (relocated to app/lib/files)", () => {
  it("detects a PDF by magic bytes", () => {
    expect(sniffMimeType(new TextEncoder().encode("%PDF-1.4\n"))).toBe("application/pdf");
  });

  it("detects a JPEG by magic bytes", () => {
    expect(sniffMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
  });

  it("detects a PNG by magic bytes", () => {
    expect(sniffMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });

  it("returns null for content matching none of the accepted signatures", () => {
    expect(sniffMimeType(new TextEncoder().encode("not a real document"))).toBeNull();
  });

  it("ACCEPTED_MIME_TYPES contains exactly the three supported types", () => {
    expect(ACCEPTED_MIME_TYPES).toEqual(new Set(["image/jpeg", "image/png", "application/pdf"]));
  });
});

describe("buildArchiveFilename", () => {
  it("falls back to the original filename when no verified data is available yet (Milestone 2A.1)", () => {
    expect(
      buildArchiveFilename({ vendorName: null, invoiceDate: null, invoiceNumber: null, originalFilename: "IMG_2024.jpg" })
    ).toBe("IMG_2024.jpg");
  });

  it("derives a friendly name from verified fields, preserving the original extension", () => {
    expect(
      buildArchiveFilename({
        vendorName: "Baldor",
        invoiceDate: "2026-08-12",
        invoiceNumber: "INV-839291",
        originalFilename: "scan.pdf",
      })
    ).toBe("Baldor_2026-08-12_INV-839291.pdf");
  });

  it("sanitizes unsafe filename characters out of each part", () => {
    expect(
      buildArchiveFilename({
        vendorName: "Baldor / Foods, Inc",
        invoiceDate: null,
        invoiceNumber: null,
        originalFilename: "scan.pdf",
      })
    ).toBe("Baldor_Foods_Inc.pdf");
  });
});
