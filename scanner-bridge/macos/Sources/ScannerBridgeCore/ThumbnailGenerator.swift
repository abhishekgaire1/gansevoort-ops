import Foundation
#if canImport(AppKit)
import AppKit
#endif

/// Produces small inline preview thumbnails for the scan-review UI (Part
/// "SCAN PREVIEW"). Deliberately downscaled -- these travel as base64
/// inside the job-status JSON, not as full-resolution scan output; final
/// PDF assembly always reads the ORIGINAL captured page file, never a
/// thumbnail.
public enum ThumbnailGenerator {
    private static let maxDimension: CGFloat = 220

    public static func base64Thumbnail(of imageFileURL: URL) -> String? {
        #if canImport(AppKit)
        guard let image = NSImage(contentsOf: imageFileURL) else { return nil }
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = maxDimension / max(size.width, size.height)
        let targetSize = NSSize(width: size.width * scale, height: size.height * scale)

        let thumbnail = NSImage(size: targetSize)
        thumbnail.lockFocus()
        image.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1.0
        )
        thumbnail.unlockFocus()

        guard
            let tiffData = thumbnail.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiffData),
            let jpegData = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.6])
        else {
            return nil
        }
        return "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
        #else
        return nil
        #endif
    }
}
