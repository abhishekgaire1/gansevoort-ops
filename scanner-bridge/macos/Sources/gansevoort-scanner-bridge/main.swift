import Foundation
import ScannerBridgeCore

let bridgeVersion = "0.1.0"

func fixturePageDirectory() -> URL {
    // Resolves the fixture pages next to the executable in a dev
    // checkout (Tests/ScannerBridgeCoreTests/Fixtures) -- the fake
    // provider is a development/test tool, never enabled in production
    // by default (Part 33: "Do not enable fake-scanner mode
    // automatically in production").
    let executableDirectory = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
    let candidates = [
        executableDirectory.appendingPathComponent("../../../../Tests/ScannerBridgeCoreTests/Fixtures"),
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Tests/ScannerBridgeCoreTests/Fixtures"),
    ]
    for candidate in candidates where FileManager.default.fileExists(atPath: candidate.path) {
        return candidate.standardizedFileURL
    }
    return candidates[0].standardizedFileURL
}

func makeProvider() -> ScannerProvider {
    let selection = ProcessInfo.processInfo.environment["GANSEVOORT_SCANNER_PROVIDER"] ?? "imagecapture"
    switch selection {
    case "fake":
        Logging.info("using fake scanner provider (GANSEVOORT_SCANNER_PROVIDER=fake)")
        return FakeScannerProvider(fixturePageDirectory: fixturePageDirectory())
    default:
        Logging.info("using ImageCaptureCore scanner provider")
        return MacImageCaptureScannerProvider()
    }
}

let arguments = CommandLine.arguments

if arguments.contains("--diagnostics") {
    runDiagnostics(testScanScannerId: valueForFlag("--test-scan", in: arguments))
} else {
    runServer()
}

// MARK: -

func valueForFlag(_ flag: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
    return args[index + 1]
}

func runServer() {
    let provider = makeProvider()
    if let macProvider = provider as? MacImageCaptureScannerProvider {
        macProvider.startBrowsing()
    }

    let port = UInt16(ProcessInfo.processInfo.environment["GANSEVOORT_SCANNER_BRIDGE_PORT"] ?? "") ?? 8765
    let originPolicy = OriginPolicy.fromEnvironment()
    let sessionManager = SessionManager()
    let jobManager = JobManager(provider: provider)
    let router = BridgeRouter(originPolicy: originPolicy, sessionManager: sessionManager, jobManager: jobManager, bridgeVersion: bridgeVersion)
    let server = HTTPServer(router: router, port: port)

    do {
        try server.start()
    } catch {
        FileHandle.standardError.write(Data("Failed to start on 127.0.0.1:\(port): \(error)\n".utf8))
        exit(1)
    }

    print("Gansevoort Scanner Bridge \(bridgeVersion) listening on http://127.0.0.1:\(port)")
    print("Allowed origins: \(originPolicy.allowedOrigins.sorted().joined(separator: ", "))")

    // Periodic cleanup sweep (Part 13/35: "expired-job cleanup").
    let sweepTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
        Task {
            await jobManager.sweepExpiredJobs()
            await sessionManager.sweepExpired()
        }
    }
    RunLoop.main.add(sweepTimer, forMode: .common)

    func shutdown() {
        server.stop()
        Task {
            await jobManager.cleanupAll()
            exit(0)
        }
    }
    // signal() itself can't take a context-capturing closure -- ignore the
    // default disposition and handle it via a DispatchSourceSignal instead.
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigintSource.setEventHandler { shutdown() }
    sigintSource.resume()
    let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigtermSource.setEventHandler { shutdown() }
    sigtermSource.resume()

    // Keeps the process alive AND gives ImageCaptureCore's
    // delegate-based callbacks a run loop to fire on -- HTTPServer's
    // Network.framework listener runs independently on GCD, so this
    // doesn't block request handling.
    RunLoop.main.run()
}

/// Part 36: a diagnostic mode the receiving-office operator runs
/// themselves -- enumerates scanners and prints only safe device
/// information, reports ADF availability, and NEVER scans unless
/// --test-scan <scannerId> is explicitly passed.
func runDiagnostics(testScanScannerId: String?) {
    let provider = makeProvider()
    if let macProvider = provider as? MacImageCaptureScannerProvider {
        macProvider.startBrowsing()
    }

    print("Gansevoort Scanner Bridge \(bridgeVersion) -- diagnostics")
    print("Waiting for device discovery (3 seconds)…")

    let semaphore = DispatchSemaphore(value: 0)
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
        Task {
            let available = await provider.isSubsystemAvailable()
            let scanners = await provider.listScanners()
            print("")
            print("scannerSubsystemAvailable: \(available)")
            print("scannerCount: \(scanners.count)")
            print("")
            if scanners.isEmpty {
                print("No scanners were discovered. If the Canon MF741Cdw is connected and")
                print("powered on, this means ImageCaptureCore/the current macOS driver cannot")
                print("see it -- STOP here and report this rather than assuming it will work.")
            }
            for scanner in scanners {
                print("- id: \(scanner.id)")
                print("  name: \(scanner.name)")
                print("  status: \(scanner.status.rawValue)")
                print("  adfAvailable: \(scanner.adfAvailable)")
            }

            if let testScanScannerId {
                print("")
                print("Starting an explicit test scan on \(testScanScannerId)…")
                let tempDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("gansevoort-scanner-bridge-diagnostics-\(UUID().uuidString)")
                try? FileManager.default.createDirectory(at: tempDirectory, withIntermediateDirectories: true)
                let stream = provider.startScan(jobId: UUID().uuidString, scannerId: testScanScannerId, workDirectory: tempDirectory)
                for await event in stream {
                    switch event {
                    case .progress(let message): print("  … \(message)")
                    case .pageCaptured(let index, let url): print("  page \(index + 1) captured -> \(url.lastPathComponent)")
                    case .finished: print("  scan finished.")
                    case .failed(let error): print("  scan FAILED: \(error.code.rawValue) -- \(error.message)")
                    }
                }
                print("  Output left in: \(tempDirectory.path)")
            }

            semaphore.signal()
        }
    }
    semaphore.wait()
}
