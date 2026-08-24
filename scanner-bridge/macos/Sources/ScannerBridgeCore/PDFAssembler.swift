import Foundation
#if canImport(PDFKit)
import PDFKit
#endif
#if canImport(AppKit)
import AppKit
#endif

public enum PDFAssemblerError: Error {
    case unsupportedPlatform
    case couldNotLoadImage(URL)
    case couldNotCreatePage(URL)
    case couldNotWriteOutput(URL)
}

/// Assembles the manager's final, edited page order into ONE PDF (Part
/// 10: "If ImageCaptureCore/driver returns individual page images/files:
/// assemble them into one ordered PDF locally... On macOS use an
/// appropriate native PDF framework such as PDFKit"). This is the ONLY
/// place a final invoice PDF is produced -- rotation/order/deletion are
/// all applied here, from the ORIGINAL full-resolution captured pages,
/// never from a preview thumbnail.
public enum PDFAssembler {
    public static func assemble(pages: [(url: URL, rotationDegrees: Int)], to outputURL: URL) throws {
        #if canImport(PDFKit) && canImport(AppKit)
        let document = PDFDocument()
        for (offset, page) in pages.enumerated() {
            guard let image = NSImage(contentsOf: page.url) else {
                throw PDFAssemblerError.couldNotLoadImage(page.url)
            }
            guard let pdfPage = PDFPage(image: image) else {
                throw PDFAssemblerError.couldNotCreatePage(page.url)
            }
            // PDFKit rotation is normalized to one of 0/90/180/270.
            let normalizedRotation = ((page.rotationDegrees % 360) + 360) % 360
            pdfPage.rotation = normalizedRotation
            document.insert(pdfPage, at: offset)
        }
        guard document.write(to: outputURL) else {
            throw PDFAssemblerError.couldNotWriteOutput(outputURL)
        }
        #else
        throw PDFAssemblerError.unsupportedPlatform
        #endif
    }
}
