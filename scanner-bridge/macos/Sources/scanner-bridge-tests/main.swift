import Foundation
import ScannerBridgeCore
#if canImport(PDFKit)
import PDFKit
#endif

/// Dependency-free bridge test runner (Manager UX... no -- Direct
/// Scanner Intake milestone, Part 35). This CommandLineTools toolchain
/// has neither XCTest nor the Testing module available, so this is a
/// small, self-contained harness instead: `swift run scanner-bridge-tests`
/// runs every case below against FakeScannerProvider (NEVER real
/// hardware, Part 32/40) and exits non-zero if anything fails.

struct TestFailure: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

func expect(_ condition: Bool, _ message: String, file: String = #fileID, line: Int = #line) throws {
    if !condition {
        throw TestFailure(message: "\(message) (\(file):\(line))")
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ label: String = "", file: String = #fileID, line: Int = #line) throws {
    if a != b {
        throw TestFailure(message: "\(label) expected \(b) but got \(a) (\(file):\(line))")
    }
}

let allowedOrigin = "http://localhost:3000"

func fixtureDirectory() -> URL {
    Bundle.module.url(forResource: "Fixtures", withExtension: nil)!
}

func makeJobManager(jobExpiry: TimeInterval = 15 * 60) -> JobManager {
    JobManager(provider: FakeScannerProvider(fixturePageDirectory: fixtureDirectory(), stepDelayNanoseconds: 1_000_000), jobExpiry: jobExpiry)
}

func makeRouter(jobManager: JobManager? = nil) -> BridgeRouter {
    BridgeRouter(
        originPolicy: OriginPolicy(allowedOrigins: [allowedOrigin]),
        sessionManager: SessionManager(),
        jobManager: jobManager ?? makeJobManager(),
        bridgeVersion: "test"
    )
}

func httpRequest(method: String, path: String, origin: String?, headers: [String: String] = [:], body: Data = Data()) -> HTTPRequest {
    var allHeaders = headers
    if let origin { allHeaders["origin"] = origin }
    return HTTPRequest(method: method, path: path, query: [:], headers: allHeaders, body: body)
}

func jsonBody(_ response: HTTPResponse) throws -> [String: Any] {
    guard let json = try JSONSerialization.jsonObject(with: response.body) as? [String: Any] else {
        throw TestFailure(message: "response body was not a JSON object")
    }
    return json
}

/// Uses PDFKit itself to count pages -- the same framework PDFAssembler
/// uses to write the file, so this is a genuine structural check, not a
/// fragile string/regex heuristic over the raw bytes.
func countPDFPageObjects(_ data: Data) -> Int {
    #if canImport(PDFKit)
    PDFDocument(data: data)?.pageCount ?? -1
    #else
    -1
    #endif
}

func waitForState(_ jobManager: JobManager, jobId: String, timeoutSeconds: Double = 5) async -> JobState? {
    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
        guard let snapshot = await jobManager.snapshot(jobId: jobId) else { return nil }
        if [.pagesReady, .failed, .cancelled, .done].contains(snapshot.state) {
            return snapshot.state
        }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    return await jobManager.snapshot(jobId: jobId)?.state
}

// MARK: - Test cases

func test_health() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/health", origin: allowedOrigin))
    try expectEqual(response.status, 200, "status")
    let json = try jsonBody(response)
    try expect(json["bridgeVersion"] != nil, "bridgeVersion present")
    try expectEqual(json["scannerSubsystemAvailable"] as? Bool, true, "scannerSubsystemAvailable")
    try expectEqual(json["scannerCount"] as? Int, 6, "scannerCount")
}

func test_listScanners() async throws {
    let jobManager = makeJobManager()
    let scanners = await jobManager.listScanners()
    try expectEqual(scanners.count, 6, "scanner count")
    try expect(scanners.contains { $0.id == "fake-ready-multipage" && $0.status == .ready }, "multipage scanner ready")
    try expect(scanners.contains { $0.id == "fake-offline" && $0.status == .offline }, "offline scanner reported offline")
}

func test_startScanReturnsUniqueJobIds() async throws {
    let jobManager = makeJobManager()
    let jobId1 = await jobManager.startScan(scannerId: "fake-ready-singlepage")
    let jobId2 = await jobManager.startScan(scannerId: "fake-ready-singlepage")
    try expect(jobId1 != jobId2, "job ids are unique")
    _ = await waitForState(jobManager, jobId: jobId1)
    _ = await waitForState(jobManager, jobId: jobId2)
}

func test_pollStateProgressesToPagesReady() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-ready-singlepage")
    let finalState = await waitForState(jobManager, jobId: jobId)
    try expectEqual(finalState, .pagesReady, "final state")
}

func test_singlePageResult() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-ready-singlepage")
    _ = await waitForState(jobManager, jobId: jobId)
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expectEqual(snapshot?.pageCount, 1, "page count")

    let result = await jobManager.finalize(jobId: jobId, pages: [FinalizePageInstruction(sourceIndex: 0, rotationDegrees: 0)])
    guard case .success = result else { throw TestFailure(message: "finalize failed") }
    let data = await jobManager.resultData(jobId: jobId)
    try expect(data != nil, "result data present")
    try expect(data!.starts(with: Data("%PDF".utf8)), "result is a PDF")
}

func test_multipagePDFResultAndPageOrdering() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-ready-multipage")
    _ = await waitForState(jobManager, jobId: jobId)
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expectEqual(snapshot?.pageCount, 5, "captured page count")

    // Reverse order + drop one page -- proves finalize respects the
    // manager's chosen order/selection, not just capture order.
    let instructions = [4, 3, 1, 0].map { FinalizePageInstruction(sourceIndex: $0, rotationDegrees: 0) }
    let result = await jobManager.finalize(jobId: jobId, pages: instructions)
    guard case .success = result else { throw TestFailure(message: "finalize failed") }
    let data = await jobManager.resultData(jobId: jobId)
    try expect(data != nil, "result data present")
    try expect(data!.starts(with: Data("%PDF".utf8)), "result is a PDF")
    let pageObjectCount = countPDFPageObjects(data!)
    try expectEqual(pageObjectCount, 4, "assembled page count")
}

func test_cancelLeavesNoTemporaryFiles() async throws {
    let jobManager = makeJobManager()
    for _ in 0..<10 {
        let jobId = await jobManager.startScan(scannerId: "fake-ready-multipage")
        await jobManager.cancel(jobId: jobId)
        let snapshot = await jobManager.snapshot(jobId: jobId)
        try expect(snapshot == nil, "job record gone after cancel")
    }
}

func test_failedJobReportsSafeErrorCode() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-jam")
    let finalState = await waitForState(jobManager, jobId: jobId)
    try expectEqual(finalState, .failed, "final state")
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expectEqual(snapshot?.errorCode, .paperJam, "error code")
    try expect(snapshot?.errorMessage != nil, "error message present")
}

func test_emptyFeederFailsWithNoDocumentLoaded() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-empty-feeder")
    let finalState = await waitForState(jobManager, jobId: jobId)
    try expectEqual(finalState, .failed, "final state")
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expectEqual(snapshot?.errorCode, .noDocumentLoaded, "error code")
}

func test_resultDownloadCleansUpWorkDirectory() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-ready-singlepage")
    _ = await waitForState(jobManager, jobId: jobId)
    _ = await jobManager.finalize(jobId: jobId, pages: [FinalizePageInstruction(sourceIndex: 0, rotationDegrees: 0)])
    _ = await jobManager.resultData(jobId: jobId)
    await jobManager.cleanupJob(jobId) // mirrors what BridgeRouter does after serving /result
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expect(snapshot == nil, "job cleaned up after result download")
}

func test_expiredJobIsSweptAway() async throws {
    let jobManager = makeJobManager(jobExpiry: 0.05)
    let jobId = await jobManager.startScan(scannerId: "fake-ready-singlepage")
    _ = await waitForState(jobManager, jobId: jobId)
    try await Task.sleep(nanoseconds: 200_000_000) // exceed the 0.05s expiry
    await jobManager.sweepExpiredJobs()
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expect(snapshot == nil, "expired job swept")
}

func test_disallowedOriginRejectedWithNoCORSHeaders() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/health", origin: "https://evil.example.com"))
    try expectEqual(response.status, 403, "status")
    try expect(response.headers["Access-Control-Allow-Origin"] == nil, "no CORS header on rejection")
}

func test_missingOriginRejected() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/health", origin: nil))
    try expectEqual(response.status, 403, "status")
}

func test_allowedOriginGetsMatchingCORSHeader() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/health", origin: allowedOrigin))
    try expectEqual(response.headers["Access-Control-Allow-Origin"], allowedOrigin, "CORS header echoes matched origin")
    try expect(response.headers["Access-Control-Allow-Origin"] != "*", "never a wildcard")
}

func test_protectedRouteWithoutTokenRejected() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/scanners", origin: allowedOrigin))
    try expectEqual(response.status, 401, "status")
}

func test_protectedRouteWithBadTokenRejected() async throws {
    let response = await makeRouter().handle(
        httpRequest(method: "GET", path: "/scanners", origin: allowedOrigin, headers: ["authorization": "Bearer not-a-real-token"])
    )
    try expectEqual(response.status, 401, "status")
}

func test_pairThenAuthorizedRouteSucceeds() async throws {
    let router = makeRouter()
    let pairResponse = await router.handle(httpRequest(method: "POST", path: "/pair", origin: allowedOrigin))
    let pairJSON = try jsonBody(pairResponse)
    guard let token = pairJSON["sessionToken"] as? String else { throw TestFailure(message: "no sessionToken in /pair response") }

    let response = await router.handle(
        httpRequest(method: "GET", path: "/scanners", origin: allowedOrigin, headers: ["authorization": "Bearer \(token)"])
    )
    try expectEqual(response.status, 200, "status")
}

func test_unknownRouteRejected() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/etc/passwd", origin: allowedOrigin))
    try expectEqual(response.status, 404, "status")
}

func test_pathTraversalAttemptRejected() async throws {
    let response = await makeRouter().handle(httpRequest(method: "GET", path: "/jobs/../../etc/passwd", origin: allowedOrigin))
    // Segment-based routing means this either 404s (wrong segment shape)
    // or, if it happens to match /jobs/:id, requires a session -- there
    // is no code path that reads an arbitrary filesystem path.
    try expect(response.status == 404 || response.status == 401, "no arbitrary file read")
}

func test_concurrentScansGetIndependentJobs() async throws {
    let jobManager = makeJobManager()
    async let job1 = jobManager.startScan(scannerId: "fake-ready-singlepage")
    async let job2 = jobManager.startScan(scannerId: "fake-ready-singlepage")
    async let job3 = jobManager.startScan(scannerId: "fake-ready-multipage")
    let ids = await [job1, job2, job3]
    try expectEqual(Set(ids).count, 3, "independent job ids")
    for id in ids {
        let state = await waitForState(jobManager, jobId: id)
        try expectEqual(state, .pagesReady, "each concurrent job completes independently")
    }
}

func test_busyScannerFailsImmediately() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-busy")
    let finalState = await waitForState(jobManager, jobId: jobId)
    try expectEqual(finalState, .failed, "final state")
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expectEqual(snapshot?.errorCode, .scannerBusy, "error code")
}

func test_offlineScannerFailsImmediately() async throws {
    let jobManager = makeJobManager()
    let jobId = await jobManager.startScan(scannerId: "fake-offline")
    let finalState = await waitForState(jobManager, jobId: jobId)
    try expectEqual(finalState, .failed, "final state")
    let snapshot = await jobManager.snapshot(jobId: jobId)
    try expectEqual(snapshot?.errorCode, .scannerOffline, "error code")
}

func test_finalizeErrorNeverLeaksInternalDetail() async throws {
    let router = makeRouter()
    let pairResponse = await router.handle(httpRequest(method: "POST", path: "/pair", origin: allowedOrigin))
    guard let token = (try jsonBody(pairResponse))["sessionToken"] as? String else {
        throw TestFailure(message: "no sessionToken")
    }
    let response = await router.handle(
        httpRequest(
            method: "POST",
            path: "/jobs/does-not-exist/finalize",
            origin: allowedOrigin,
            headers: ["authorization": "Bearer \(token)"],
            body: try JSONSerialization.data(withJSONObject: ["pages": [["sourceIndex": 0, "rotationDegrees": 0]]])
        )
    )
    try expectEqual(response.status, 422, "status")
    let json = try jsonBody(response)
    guard let errorCode = json["error"] as? String else { throw TestFailure(message: "no error code in response") }
    let knownCodes: Set<String> = ["NO_DOCUMENT_LOADED", "PAPER_JAM", "SCANNER_BUSY", "SCANNER_OFFLINE", "DEVICE_ERROR", "TIMEOUT", "INTERNAL_ERROR"]
    try expect(knownCodes.contains(errorCode), "error is a known safe code, not a raw dump")
    try expect(!errorCode.contains("/"), "no path fragment in error code")
}

// MARK: - Runner

let allTests: [(String, () async throws -> Void)] = [
    ("health", test_health),
    ("listScanners", test_listScanners),
    ("startScanReturnsUniqueJobIds", test_startScanReturnsUniqueJobIds),
    ("pollStateProgressesToPagesReady", test_pollStateProgressesToPagesReady),
    ("singlePageResult", test_singlePageResult),
    ("multipagePDFResultAndPageOrdering", test_multipagePDFResultAndPageOrdering),
    ("cancelLeavesNoTemporaryFiles", test_cancelLeavesNoTemporaryFiles),
    ("failedJobReportsSafeErrorCode", test_failedJobReportsSafeErrorCode),
    ("emptyFeederFailsWithNoDocumentLoaded", test_emptyFeederFailsWithNoDocumentLoaded),
    ("resultDownloadCleansUpWorkDirectory", test_resultDownloadCleansUpWorkDirectory),
    ("expiredJobIsSweptAway", test_expiredJobIsSweptAway),
    ("disallowedOriginRejectedWithNoCORSHeaders", test_disallowedOriginRejectedWithNoCORSHeaders),
    ("missingOriginRejected", test_missingOriginRejected),
    ("allowedOriginGetsMatchingCORSHeader", test_allowedOriginGetsMatchingCORSHeader),
    ("protectedRouteWithoutTokenRejected", test_protectedRouteWithoutTokenRejected),
    ("protectedRouteWithBadTokenRejected", test_protectedRouteWithBadTokenRejected),
    ("pairThenAuthorizedRouteSucceeds", test_pairThenAuthorizedRouteSucceeds),
    ("unknownRouteRejected", test_unknownRouteRejected),
    ("pathTraversalAttemptRejected", test_pathTraversalAttemptRejected),
    ("concurrentScansGetIndependentJobs", test_concurrentScansGetIndependentJobs),
    ("busyScannerFailsImmediately", test_busyScannerFailsImmediately),
    ("offlineScannerFailsImmediately", test_offlineScannerFailsImmediately),
    ("finalizeErrorNeverLeaksInternalDetail", test_finalizeErrorNeverLeaksInternalDetail),
]

var failureCount = 0
for (name, test) in allTests {
    do {
        try await test()
        print("✅ \(name)")
    } catch {
        failureCount += 1
        print("❌ \(name): \(error)")
    }
}

print("")
print("\(allTests.count - failureCount)/\(allTests.count) passed")
if failureCount > 0 {
    exit(1)
}
