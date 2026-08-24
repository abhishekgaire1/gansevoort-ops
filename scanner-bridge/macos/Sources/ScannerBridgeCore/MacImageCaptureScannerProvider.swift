import Foundation
import ImageCaptureCore

/// Real hardware provider using Apple's supported ImageCaptureCore
/// framework (Part 3: "prefer Apple's supported scanner framework...
/// Do NOT use an undocumented Canon private API. Do NOT reverse-engineer
/// ScanGear MF"). No Canon-specific code exists anywhere in this file --
/// it only ever talks to whatever ICScannerDevice(s) macOS itself
/// discovers through the currently installed driver.
///
/// IMPORTANT / UNVERIFIED AGAINST REAL HARDWARE: every symbol used here
/// was confirmed to COMPILE against the ImageCaptureCore framework on
/// this Mac's toolchain (delegate method signatures, requestScan(),
/// requestSelect(_:), functional-unit properties), but this class has
/// NOT been exercised against an actual Canon MF741Cdw -- that requires
/// physical hardware only the receiving-office operator has. Run the
/// bridge's `--diagnostics` mode on that Mac before trusting this beyond
/// "it compiles and follows the documented API shape" (Part 36/42: "Do
/// not claim hardware integration is complete until I return the real
/// diagnostic result").
public final class MacImageCaptureScannerProvider: NSObject, ScannerProvider, @unchecked Sendable {
    private let browser = ICDeviceBrowser()
    private var devicesById: [String: ICScannerDevice] = [:]
    private var sessions: [String: ScanSession] = [:]
    private let lock = NSLock()
    private var browserStarted = false

    public override init() {
        super.init()
    }

    /// Synchronous helper so lock/unlock is never called directly from an
    /// `async` function body (a warning under this toolchain, an error
    /// under strict Swift 6 concurrency checking) -- every locked access
    /// goes through this.
    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// Must be called once, from the same thread that will pump
    /// RunLoop.main (see main.swift) -- ICDeviceBrowser delivers its
    /// delegate callbacks on the run loop it was started from.
    public func startBrowsing() {
        let shouldStart = withLock { () -> Bool in
            guard !browserStarted else { return false }
            browserStarted = true
            return true
        }
        guard shouldStart else { return }
        browser.delegate = self
        browser.browsedDeviceTypeMask = .scanner
        browser.start()
    }

    public func isSubsystemAvailable() async -> Bool {
        withLock { browserStarted }
    }

    public func listScanners() async -> [ScannerDevice] {
        let devices = withLock { devicesById }
        return devices.map { id, device in
            let adfAvailable = device.availableFunctionalUnitTypes.contains(
                NSNumber(value: ICScannerFunctionalUnitType.documentFeeder.rawValue)
            )
            // A device only remains in devicesById while ICDeviceBrowser
            // actively reports it as present (didRemove evicts it), so
            // anything still here is by definition currently reachable.
            return ScannerDevice(id: id, name: device.name ?? "Scanner", status: .ready, adfAvailable: adfAvailable)
        }.sorted { $0.name < $1.name }
    }

    // jobId is unused here -- a real ICScannerDevice can only run one
    // scan at a time regardless, so `sessions` keyed by scannerId alone
    // has no equivalent to the fake provider's reset-on-start race (there
    // is no per-attempt reset to race with).
    public func startScan(jobId: String, scannerId: String, workDirectory: URL) -> AsyncStream<ScanEvent> {
        AsyncStream { continuation in
            let device = withLock { devicesById[scannerId] }
            guard let device else {
                continuation.yield(.failed(ScanError(code: .scannerOffline, message: "Scanner is no longer available.")))
                continuation.finish()
                return
            }
            let session = ScanSession(device: device, workDirectory: workDirectory, continuation: continuation)
            withLock { sessions[scannerId] = session }

            continuation.onTermination = { [weak self] _ in
                self?.withLock { self?.sessions[scannerId] = nil }
            }

            session.begin()
        }
    }

    public func cancelScan(jobId: String, scannerId: String) async {
        let session = withLock { sessions[scannerId] }
        session?.cancel()
    }
}

extension MacImageCaptureScannerProvider: ICDeviceBrowserDelegate {
    public func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard let scanner = device as? ICScannerDevice else { return }
        // ImageCaptureCore devices don't expose a stable public
        // identifier suitable as an API id -- serialNumber/name are the
        // closest stable-ish handles; falling back to a fresh UUID never
        // breaks discovery, it just means re-plugging can surface as a
        // "new" id, which is an acceptable tradeoff for this milestone.
        let id = scanner.serialNumberString ?? scanner.name ?? UUID().uuidString
        withLock { devicesById[id] = scanner }
    }

    public func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {
        guard let scanner = device as? ICScannerDevice else { return }
        withLock {
            if let id = devicesById.first(where: { $0.value === scanner })?.key {
                devicesById[id] = nil
            }
        }
    }
}

/// One in-flight scan's delegate + state -- kept alive by the provider's
/// `sessions` dictionary for exactly as long as the scan runs.
private final class ScanSession: NSObject, ICScannerDeviceDelegate {
    private let device: ICScannerDevice
    private let workDirectory: URL
    private let continuation: AsyncStream<ScanEvent>.Continuation
    private var pageIndex = 0
    private var cancelled = false

    init(device: ICScannerDevice, workDirectory: URL, continuation: AsyncStream<ScanEvent>.Continuation) {
        self.device = device
        self.workDirectory = workDirectory
        self.continuation = continuation
    }

    func begin() {
        device.delegate = self
        continuation.yield(.progress(message: "Starting scanner…"))
        if device.hasOpenSession {
            configureAndScan()
        } else {
            device.requestOpenSession()
        }
    }

    func cancel() {
        cancelled = true
        device.cancelScan()
    }

    private func configureAndScan() {
        guard !cancelled else { return }
        device.requestSelect(.documentFeeder)
        guard let feeder = device.selectedFunctionalUnit as? ICScannerFunctionalUnitDocumentFeeder else {
            continuation.yield(.failed(ScanError(code: .deviceError, message: "This scanner has no usable document feeder.")))
            continuation.finish()
            return
        }
        guard feeder.documentLoaded else {
            continuation.yield(.failed(ScanError(code: .noDocumentLoaded, message: "No document detected in the feeder.")))
            continuation.finish()
            return
        }

        // Sensible fixed defaults only (Part 9) -- never twenty exposed
        // settings. Simplex ADF, ~300 DPI (or the closest supported
        // value), color (grayscale can be revisited after real
        // extraction-quality testing on the actual device), PDF-ready
        // JPEG pages assembled into one PDF later by PDFAssembler.
        feeder.duplexScanningEnabled = false
        let preferredDPI = 300
        feeder.resolution = feeder.supportedResolutions.contains(preferredDPI)
            ? preferredDPI
            : (feeder.supportedResolutions.max(by: { abs($0 - preferredDPI) > abs($1 - preferredDPI) }) ?? preferredDPI)
        feeder.pixelDataType = .RGB
        feeder.bitDepth = .depth8Bits

        device.transferMode = .fileBased
        device.downloadsDirectory = workDirectory
        device.documentName = "page"
        device.documentUTI = "public.jpeg"

        continuation.yield(.progress(message: "Scanning page 1…"))
        device.requestScan()
    }

    // MARK: - ICDeviceDelegate

    func device(_ device: ICDevice, didOpenSessionWithError error: (any Error)?) {
        if let error {
            continuation.yield(.failed(ScanError(code: .deviceError, message: "Could not open a session with the scanner.")))
            Logging.debug("ICDevice didOpenSessionWithError", ["error": error.localizedDescription])
            continuation.finish()
            return
        }
        configureAndScan()
    }

    func device(_ device: ICDevice, didCloseSessionWithError error: (any Error)?) {}

    func didRemove(_ device: ICDevice) {
        continuation.yield(.failed(ScanError(code: .scannerOffline, message: "The scanner was disconnected.")))
        continuation.finish()
    }

    // MARK: - ICScannerDeviceDelegate (optional callbacks)

    func scannerDevice(_ scanner: ICScannerDevice, didScanTo url: URL) {
        guard !cancelled else { return }
        let index = pageIndex
        pageIndex += 1
        continuation.yield(.pageCaptured(index: index, imageFileURL: url))
        continuation.yield(.progress(message: "Scanning page \(pageIndex + 1)…"))
    }

    func scannerDevice(_ scanner: ICScannerDevice, didCompleteScanWithError error: (any Error)?) {
        finishScan(error: error)
    }

    func scannerDeviceDidCompleteScan(_ scanner: ICScannerDevice, error: (any Error)?) {
        finishScan(error: error)
    }

    private func finishScan(error: (any Error)?) {
        if cancelled {
            continuation.yield(.failed(ScanError(code: .internalError, message: "Scan cancelled.")))
            continuation.finish()
            return
        }
        if let error {
            Logging.debug("scan completed with error", ["error": error.localizedDescription])
            continuation.yield(.failed(mapScanError(error)))
            continuation.finish()
            return
        }
        guard pageIndex > 0 else {
            continuation.yield(.failed(ScanError(code: .noDocumentLoaded, message: "No pages were scanned.")))
            continuation.finish()
            return
        }
        continuation.yield(.finished)
        continuation.finish()
    }

    private func mapScanError(_ error: any Error) -> ScanError {
        // ImageCaptureCore surfaces device-level failures as plain
        // NSError with framework-specific codes; without the real
        // device to enumerate its actual jam/busy codes we fall back to
        // a generic device error rather than guessing wrong specifics.
        // Never surfaced to the manager verbatim (Part 23) -- only this
        // safe code/message pair is.
        ScanError(code: .deviceError, message: "The scanner reported an error.")
    }
}
