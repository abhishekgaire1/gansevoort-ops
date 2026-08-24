import Foundation

/// Deterministic, hardware-free provider (Part 32/33: "Scanner bridge
/// abstraction should support a FAKE/DEV scanner provider... Do NOT make
/// tests invoke the actual Canon"). Selected via GANSEVOORT_SCANNER_PROVIDER=fake
/// (see main.swift) -- never enabled automatically in a way that could
/// reach production, since it's an explicit, deliberate CLI/env choice
/// the developer makes when starting the bridge.
///
/// Each simulated scenario is its own device id, so a test (or a
/// developer poking the bridge with curl) can request exactly the
/// behavior it wants without any hidden state:
///   fake-ready-multipage  -- 5-page ADF scan (default "just works" case)
///   fake-ready-singlepage -- 1-page ADF scan
///   fake-offline          -- listed but OFFLINE, startScan fails immediately
///   fake-jam              -- fails mid-scan with PAPER_JAM
///   fake-empty-feeder     -- fails immediately with NO_DOCUMENT_LOADED
///   fake-busy             -- fails immediately with SCANNER_BUSY
public final class FakeScannerProvider: ScannerProvider, @unchecked Sendable {
    private let fixturePageURLs: [URL]
    private let stepDelayNanoseconds: UInt64
    private let cancelledJobIds = ActorSet()

    /// `fixturePageDirectory` should contain page-1.jpg..page-N.jpg (see
    /// Tests/ScannerBridgeCoreTests/Fixtures). `stepDelayNanoseconds`
    /// defaults to a small but non-zero delay so progress events are
    /// observably sequenced in tests without slowing them down much.
    public init(fixturePageDirectory: URL, stepDelayNanoseconds: UInt64 = 5_000_000) {
        self.fixturePageURLs = (1...5)
            .map { fixturePageDirectory.appendingPathComponent("page-\($0).jpg") }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
        self.stepDelayNanoseconds = stepDelayNanoseconds
    }

    public func isSubsystemAvailable() async -> Bool { true }

    public func listScanners() async -> [ScannerDevice] {
        [
            ScannerDevice(id: "fake-ready-multipage", name: "Fake Scanner (multipage)", status: .ready, adfAvailable: true),
            ScannerDevice(id: "fake-ready-singlepage", name: "Fake Scanner (single page)", status: .ready, adfAvailable: true),
            ScannerDevice(id: "fake-offline", name: "Fake Scanner (offline)", status: .offline, adfAvailable: false),
            ScannerDevice(id: "fake-jam", name: "Fake Scanner (jams mid-scan)", status: .ready, adfAvailable: true),
            ScannerDevice(id: "fake-empty-feeder", name: "Fake Scanner (empty feeder)", status: .ready, adfAvailable: true),
            ScannerDevice(id: "fake-busy", name: "Fake Scanner (busy)", status: .busy, adfAvailable: true),
        ]
    }

    public func startScan(jobId: String, scannerId: String, workDirectory: URL) -> AsyncStream<ScanEvent> {
        AsyncStream { continuation in
            let task = Task {
                await self.runScenario(jobId: jobId, scannerId: scannerId, workDirectory: workDirectory, continuation: continuation)
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Keyed by jobId, NOT scannerId -- scannerId is reused across every
    /// attempt on the same fake device, so keying (and resetting-on-
    /// start) by scannerId alone lets a cancel issued for attempt N race
    /// with attempt N+1's own reset and get silently lost. jobId is
    /// fresh per attempt, so there is nothing to race with.
    public func cancelScan(jobId: String, scannerId: String) async {
        await cancelledJobIds.insert(jobId)
    }

    private func runScenario(jobId: String, scannerId: String, workDirectory: URL, continuation: AsyncStream<ScanEvent>.Continuation) async {
        switch scannerId {
        case "fake-offline":
            continuation.yield(.failed(ScanError(code: .scannerOffline, message: "Scanner is offline.")))
            continuation.finish()
            return
        case "fake-busy":
            continuation.yield(.failed(ScanError(code: .scannerBusy, message: "Scanner is busy with another job.")))
            continuation.finish()
            return
        case "fake-empty-feeder":
            continuation.yield(.progress(message: "Starting scanner…"))
            try? await Task.sleep(nanoseconds: stepDelayNanoseconds)
            continuation.yield(.failed(ScanError(code: .noDocumentLoaded, message: "No document detected in the feeder.")))
            continuation.finish()
            return
        default:
            break
        }

        let pageCount: Int
        switch scannerId {
        case "fake-ready-singlepage": pageCount = 1
        case "fake-jam": pageCount = 5
        default: pageCount = min(5, fixturePageURLs.count)
        }

        continuation.yield(.progress(message: "Starting scanner…"))
        try? await Task.sleep(nanoseconds: stepDelayNanoseconds)

        for index in 0..<pageCount {
            // Checked BEFORE every step, not just via the swallowed
            // Task.sleep cancellation error below -- a caller that
            // cancels the wrapping Task (JobManager.cancel awaits this
            // task's completion before deleting the work directory) must
            // see this loop actually stop, not silently keep writing
            // pages to a directory the caller is about to remove.
            let explicitlyCancelled = await cancelledJobIds.contains(jobId)
            if Task.isCancelled || explicitlyCancelled {
                continuation.yield(.failed(ScanError(code: .internalError, message: "Scan cancelled.")))
                continuation.finish()
                return
            }

            if scannerId == "fake-jam", index == 2 {
                continuation.yield(.failed(ScanError(code: .paperJam, message: "Paper jam in the document feeder.")))
                continuation.finish()
                return
            }

            continuation.yield(.progress(message: "Scanning page \(index + 1)…"))
            try? await Task.sleep(nanoseconds: stepDelayNanoseconds)

            guard !fixturePageURLs.isEmpty else {
                continuation.yield(.failed(ScanError(code: .internalError, message: "No fixture pages available.")))
                continuation.finish()
                return
            }
            let sourceURL = fixturePageURLs[index % fixturePageURLs.count]
            let destinationURL = workDirectory.appendingPathComponent(String(format: "page-%03d.jpg", index))
            do {
                if FileManager.default.fileExists(atPath: destinationURL.path) {
                    try FileManager.default.removeItem(at: destinationURL)
                }
                try FileManager.default.copyItem(at: sourceURL, to: destinationURL)
            } catch {
                continuation.yield(.failed(ScanError(code: .internalError, message: "Could not write scanned page.")))
                continuation.finish()
                return
            }
            continuation.yield(.pageCaptured(index: index, imageFileURL: destinationURL))
        }

        continuation.yield(.progress(message: "Preparing pages…"))
        try? await Task.sleep(nanoseconds: stepDelayNanoseconds)
        continuation.yield(.finished)
        continuation.finish()
    }
}

/// Tiny actor-backed set -- avoids a plain `var` mutated from multiple
/// concurrent scan tasks (cancel can race a scan in progress).
private actor ActorSet {
    private var values = Set<String>()
    func insert(_ value: String) { values.insert(value) }
    func remove(_ value: String) { values.remove(value) }
    func contains(_ value: String) -> Bool { values.contains(value) }
}
