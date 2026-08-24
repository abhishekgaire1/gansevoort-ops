import Foundation
import os

/// The ONLY logging surface this bridge uses (Part "DO NOT LOG DOCUMENT
/// CONTENT"): every call site passes plain, short, safe key/value pairs
/// -- jobId, scanner name, page count, byte size, timing, error codes.
/// Never a PDF/image byte, OCR text, or business-document content. Logs
/// stay local (os_log, viewable only via `log stream`/Console.app on
/// this Mac) -- nothing here is ever sent over the network.
public enum Logging {
    private static let logger = Logger(subsystem: "com.gansevoort.scanner-bridge", category: "bridge")

    public static func debug(_ message: String, _ context: [String: String] = [:]) {
        if context.isEmpty {
            logger.debug("\(message, privacy: .public)")
        } else {
            let contextText = context.map { "\($0)=\($1)" }.joined(separator: " ")
            logger.debug("\(message, privacy: .public) \(contextText, privacy: .public)")
        }
    }

    public static func info(_ message: String, _ context: [String: String] = [:]) {
        if context.isEmpty {
            logger.info("\(message, privacy: .public)")
        } else {
            let contextText = context.map { "\($0)=\($1)" }.joined(separator: " ")
            logger.info("\(message, privacy: .public) \(contextText, privacy: .public)")
        }
    }
}
