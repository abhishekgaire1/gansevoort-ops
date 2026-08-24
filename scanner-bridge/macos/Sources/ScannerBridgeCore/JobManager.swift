import Foundation
#if canImport(AppKit)
import AppKit
#endif

public enum JobState: String, Sendable {
    case starting = "STARTING"
    case scanning = "SCANNING"
    case processing = "PROCESSING"
    case pagesReady = "PAGES_READY"
    case finalizing = "FINALIZING"
    case done = "DONE"
    case failed = "FAILED"
    case cancelled = "CANCELLED"
}

public struct JobPageInfo: Sendable {
    public let index: Int
    public let thumbnailBase64: String
}

public struct FinalizePageInstruction: Sendable {
    public let sourceIndex: Int
    public let rotationDegrees: Int

    public init(sourceIndex: Int, rotationDegrees: Int) {
        self.sourceIndex = sourceIndex
        self.rotationDegrees = rotationDegrees
    }
}

public struct JobSnapshot: Sendable {
    public let id: String
    public let state: JobState
    public let progressMessage: String?
    public let pageCount: Int?
    public let pages: [JobPageInfo]?
    public let errorCode: ScanErrorCode?
    public let errorMessage: String?
}

/// One scan job's full lifecycle: STARTING -> SCANNING -> PROCESSING ->
/// PAGES_READY (manager previews/edits, purely client-side) ->
/// FINALIZING -> DONE (final PDF ready for one-time download), or FAILED
/// / CANCELLED at any point. This is a LOCAL hardware job, deliberately
/// separate from the server-side Supabase document-extraction queue
/// (Part "TIMEOUTS / RECOVERY": "Do not add this to our Supabase
/// document-extraction queue").
actor Job {
    let id: String
    let scannerId: String
    private(set) var state: JobState = .starting
    private(set) var progressMessage: String? = "Starting scanner…"
    private(set) var errorCode: ScanErrorCode?
    private(set) var errorMessage: String?
    private(set) var capturedPages: [ScannedPage] = []
    private(set) var finalPDFURL: URL?

    let workDirectory: URL
    let createdAt: Date
    private(set) var lastAccessedAt: Date

    init(id: String, scannerId: String, workDirectory: URL) {
        self.id = id
        self.scannerId = scannerId
        self.workDirectory = workDirectory
        self.createdAt = Date()
        self.lastAccessedAt = Date()
    }

    func touch() { lastAccessedAt = Date() }

    func setState(_ newState: JobState, progress: String? = nil) {
        state = newState
        if let progress { progressMessage = progress }
    }

    func addPage(_ page: ScannedPage) {
        capturedPages.append(page)
    }

    func markPagesReady() {
        state = .pagesReady
        progressMessage = "Scan complete."
    }

    func markFailed(_ error: ScanError) {
        state = .failed
        errorCode = error.code
        errorMessage = error.message
    }

    func markCancelled() {
        state = .cancelled
        progressMessage = "Scan cancelled."
    }

    func setFinalPDF(_ url: URL) {
        finalPDFURL = url
        state = .done
    }

    func snapshot(thumbnails: [JobPageInfo]?) -> JobSnapshot {
        JobSnapshot(
            id: id,
            state: state,
            progressMessage: progressMessage,
            pageCount: capturedPages.isEmpty ? nil : capturedPages.count,
            pages: thumbnails,
            errorCode: errorCode,
            errorMessage: errorMessage
        )
    }
}

public actor JobManager {
    private let provider: ScannerProvider
    private let rootTempDirectory: URL
    private var jobs: [String: Job] = [:]
    /// Bridge-restart-scoped cancellation flags -- Job itself doesn't
    /// need one; a provider-level cancel is issued via `cancelScan`.
    private var scanTasks: [String: Task<Void, Never>] = [:]

    /// Jobs older than this (from creation) are eligible for cleanup on
    /// the next sweep, regardless of state -- bounds how long ANY
    /// scanned-but-abandoned invoice can linger on disk (Part 13:
    /// "Temporary files must be cleaned up after... expiry").
    private let jobExpiry: TimeInterval

    public init(provider: ScannerProvider, jobExpiry: TimeInterval = 15 * 60) {
        self.provider = provider
        self.jobExpiry = jobExpiry
        self.rootTempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("gansevoort-scanner-bridge", isDirectory: true)
        try? FileManager.default.createDirectory(at: rootTempDirectory, withIntermediateDirectories: true)
    }

    public func listScanners() async -> [ScannerDevice] {
        await provider.listScanners()
    }

    public func isSubsystemAvailable() async -> Bool {
        await provider.isSubsystemAvailable()
    }

    public func startScan(scannerId: String) -> String {
        let jobId = UUID().uuidString
        let workDirectory = rootTempDirectory.appendingPathComponent(jobId, isDirectory: true)
        try? FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)

        let job = Job(id: jobId, scannerId: scannerId, workDirectory: workDirectory)
        jobs[jobId] = job

        let task = Task { [provider] in
            await job.setState(.scanning, progress: "Starting scanner…")
            let stream = provider.startScan(jobId: jobId, scannerId: scannerId, workDirectory: workDirectory)
            // Deliberately NOT an early `if Task.isCancelled { break }`
            // here -- JobManager.cancel awaits this whole task's
            // completion specifically so the work directory is never
            // deleted while the provider might still be mid-write.
            // Draining the stream to its natural end (the provider's own
            // cancellation check yields .failed then finishes) is what
            // makes that await meaningful; breaking early would let this
            // task "complete" while the producer is still running.
            for await event in stream {
                switch event {
                case .progress(let message):
                    await job.setState(.scanning, progress: message)
                case .pageCaptured(let index, let imageFileURL):
                    await job.addPage(ScannedPage(index: index, imageFileURL: imageFileURL))
                    await job.setState(.scanning, progress: "Scanning page \(index + 1)…")
                case .finished:
                    await job.setState(.processing, progress: "Preparing pages…")
                    await job.markPagesReady()
                case .failed(let error):
                    await job.markFailed(error)
                }
            }
        }
        scanTasks[jobId] = task
        return jobId
    }

    /// Cancels an in-flight scan (Part 25). Looks up the job's own
    /// scannerId rather than trusting one from the caller -- the bridge
    /// already knows it, so there's nothing for the browser to get wrong
    /// or omit.
    ///
    /// Deliberately does NOT call `task.cancel()` on the consuming task.
    /// `for await event in stream` is cooperative-cancellation-aware on
    /// its OWN suspension point, independent of whether the PRODUCER
    /// (the provider's own scan loop) has actually stopped -- cancelling
    /// the consumer can make `for await` return early the instant
    /// cancellation is requested, while the producer is still mid-write
    /// a few lines later. Awaiting a task that exited that way is NOT a
    /// reliable signal that no more files will be written, and deleting
    /// the work directory at that point can race a write that's still
    /// in flight. Instead: signal the PRODUCER via
    /// provider.cancelScan(...) and let the stream drain to its natural
    /// end (the provider's own next cancellation check yields .failed,
    /// then finishes) -- awaiting task.value THEN is a genuine guarantee
    /// the producer has fully stopped.
    public func cancel(jobId: String) async {
        guard let job = jobs[jobId] else { return }
        let scannerId = job.scannerId
        await provider.cancelScan(jobId: jobId, scannerId: scannerId)
        if let task = scanTasks[jobId] {
            await task.value
        }
        scanTasks[jobId] = nil
        await job.markCancelled()
        await cleanupJob(jobId)
    }

    /// Thumbnail size is deliberately small -- these travel inline as
    /// base64 in the job-status JSON response, so keeping them compact
    /// matters for the local-loopback payload (Part "SCAN PREVIEW" only
    /// needs a recognizable preview, not print quality; the FULL-res
    /// captured page is what final assembly uses).
    public func snapshot(jobId: String) async -> JobSnapshot? {
        guard let job = jobs[jobId] else { return nil }
        await job.touch()
        let state = await job.state
        var thumbnails: [JobPageInfo]? = nil
        if state == .pagesReady || state == .done {
            let pages = await job.capturedPages
            thumbnails = pages.map { page in
                JobPageInfo(index: page.index, thumbnailBase64: ThumbnailGenerator.base64Thumbnail(of: page.imageFileURL) ?? "")
            }
        }
        return await job.snapshot(thumbnails: thumbnails)
    }

    /// Assembles the manager-edited page set into ONE ordered PDF (Part
    /// 10/12) using PDFAssembler (PDFKit). Only reachable from
    /// PAGES_READY -- a job that already failed/cancelled/finished has
    /// nothing left to finalize.
    public func finalize(jobId: String, pages instructions: [FinalizePageInstruction]) async -> Result<Void, ScanError> {
        guard let job = jobs[jobId] else {
            return .failure(ScanError(code: .internalError, message: "Unknown job."))
        }
        let state = await job.state
        guard state == .pagesReady else {
            return .failure(ScanError(code: .internalError, message: "This scan is not ready to finalize."))
        }
        guard !instructions.isEmpty else {
            return .failure(ScanError(code: .internalError, message: "At least one page is required."))
        }

        await job.setState(.finalizing, progress: "Preparing PDF…")
        let capturedPages = await job.capturedPages
        let byIndex = Dictionary(uniqueKeysWithValues: capturedPages.map { ($0.index, $0) })

        var orderedURLs: [(url: URL, rotationDegrees: Int)] = []
        for instruction in instructions {
            guard let page = byIndex[instruction.sourceIndex] else {
                return .failure(ScanError(code: .internalError, message: "One or more pages could not be found."))
            }
            orderedURLs.append((page.imageFileURL, instruction.rotationDegrees))
        }

        let outputURL = job.workDirectory.appendingPathComponent("assembled.pdf")
        do {
            try PDFAssembler.assemble(pages: orderedURLs, to: outputURL)
        } catch {
            await job.markFailed(ScanError(code: .internalError, message: "Could not assemble the final PDF."))
            return .failure(ScanError(code: .internalError, message: "Could not assemble the final PDF."))
        }

        await job.setFinalPDF(outputURL)
        return .success(())
    }

    public func resultData(jobId: String) async -> Data? {
        guard let job = jobs[jobId] else { return nil }
        await job.touch()
        guard let url = await job.finalPDFURL else { return nil }
        return try? Data(contentsOf: url)
    }

    /// Removes a job's temporary directory and its in-memory record.
    /// Called on acceptance download, cancellation, and by the periodic
    /// expiry sweep (Part 13/35: "temporary-file cleanup" /
    /// "expired-job cleanup").
    public func cleanupJob(_ jobId: String) async {
        if let job = jobs[jobId] {
            try? FileManager.default.removeItem(at: job.workDirectory)
        }
        jobs[jobId] = nil
        scanTasks[jobId]?.cancel()
        scanTasks[jobId] = nil
    }

    /// Call periodically (main.swift runs this on a timer). Never
    /// touches jobs younger than jobExpiry, so an in-progress scan is
    /// never swept mid-flight.
    public func sweepExpiredJobs() async {
        let now = Date()
        for (jobId, job) in jobs {
            let lastAccessedAt = await job.lastAccessedAt
            if now.timeIntervalSince(lastAccessedAt) > jobExpiry {
                await cleanupJob(jobId)
            }
        }
    }

    /// Best-effort cleanup of every job directory this process created,
    /// called at shutdown (Part 13: "helper restart where practical").
    public func cleanupAll() async {
        for jobId in jobs.keys {
            await cleanupJob(jobId)
        }
        try? FileManager.default.removeItem(at: rootTempDirectory)
    }
}
