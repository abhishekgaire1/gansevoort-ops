import Foundation

/// A discovered scanner device. Intentionally minimal -- the web app
/// only ever needs enough to let a manager pick a device and see whether
/// it's usable right now.
public struct ScannerDevice: Sendable, Equatable {
    public let id: String
    public let name: String
    public let status: ScannerStatus
    public let adfAvailable: Bool

    public init(id: String, name: String, status: ScannerStatus, adfAvailable: Bool) {
        self.id = id
        self.name = name
        self.status = status
        self.adfAvailable = adfAvailable
    }
}

public enum ScannerStatus: String, Sendable {
    case ready = "READY"
    case busy = "BUSY"
    case offline = "OFFLINE"
}

/// One captured page, at full resolution -- kept only in the job's
/// temporary directory, never logged, never persisted beyond the job's
/// lifetime (Part "DO NOT LOG DOCUMENT CONTENT" / "TEMPORARY-FILE
/// CLEANUP").
public struct ScannedPage: Sendable {
    public let index: Int
    public let imageFileURL: URL

    public init(index: Int, imageFileURL: URL) {
        self.index = index
        self.imageFileURL = imageFileURL
    }
}

/// Safe, serializable scan failure reasons -- never a raw
/// ImageCaptureCore/driver error dump reaches the browser (Part "SCAN
/// JOB STATE": "Do not expose ImageCaptureCore/native error dumps
/// directly to managers").
public enum ScanErrorCode: String, Sendable {
    case noDocumentLoaded = "NO_DOCUMENT_LOADED"
    case paperJam = "PAPER_JAM"
    case scannerBusy = "SCANNER_BUSY"
    case scannerOffline = "SCANNER_OFFLINE"
    case deviceError = "DEVICE_ERROR"
    case timeout = "TIMEOUT"
    case internalError = "INTERNAL_ERROR"
}

public struct ScanError: Sendable, Error {
    public let code: ScanErrorCode
    /// Safe for a manager to read (Part 23) -- never a native stack
    /// trace or driver-internal string. Diagnostic detail, if any,
    /// belongs in the LOCAL log only (see Logging.swift), not here.
    public let message: String

    public init(code: ScanErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

/// Delivered by a provider as a scan progresses -- the JobManager
/// forwards these into job state (Part "SCAN JOB STATE").
public enum ScanEvent: Sendable {
    case pageCaptured(index: Int, imageFileURL: URL)
    case progress(message: String)
    case finished
    case failed(ScanError)
}

/// The hardware abstraction every scanner integration implements (Part
/// 3's ScannerProvider / MacImageCaptureScannerProvider /
/// LongDocumentScannerProvider concept). A provider never touches HTTP,
/// sessions, or PDF assembly -- JobManager owns orchestration; a
/// provider only knows how to talk to (real or fake) hardware.
public protocol ScannerProvider: Sendable {
    /// Whether the underlying scanner subsystem itself initialized
    /// successfully (Part "HELPER HEALTH": scannerSubsystemAvailable) --
    /// distinct from "any scanners are currently plugged in." The fake
    /// provider is always available; the real provider reflects whether
    /// ImageCaptureCore's device browser could actually start.
    func isSubsystemAvailable() async -> Bool

    func listScanners() async -> [ScannerDevice]

    /// Starts a scan on the named device and streams events as pages are
    /// captured. `jobId` is a fresh, globally-unique identifier for THIS
    /// scan attempt (never reused, unlike scannerId which is stable
    /// across many attempts on the same device) -- providers that track
    /// per-attempt cancellation state must key it by `jobId`, never by
    /// scannerId alone, or a cancel issued for one attempt could race
    /// with (and be silently cleared by) the start of the NEXT attempt
    /// on the same device. `workDirectory` is a job-scoped temporary
    /// directory the provider should write full-resolution page images
    /// into (already created by the caller). The returned stream ends
    /// after `.finished` or `.failed`.
    func startScan(jobId: String, scannerId: String, workDirectory: URL) -> AsyncStream<ScanEvent>

    /// Best-effort cancellation of an in-flight scan for this provider.
    /// Providers that can't cancel mid-page should still stop feeding
    /// further pages as soon as practical.
    func cancelScan(jobId: String, scannerId: String) async
}
