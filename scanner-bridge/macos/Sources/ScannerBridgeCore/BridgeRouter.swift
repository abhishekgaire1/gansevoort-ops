import Foundation

/// Wires the narrow HTTP surface (Part "LOCAL-ONLY SECURITY": "Use a
/// narrow API... Do not expose arbitrary filesystem browsing, arbitrary
/// path reads, shell execution, generic file upload, arbitrary URL
/// fetching") to JobManager/SessionManager, enforcing Origin + session
/// checks on every route except the two that must work BEFORE a session
/// exists (/health, /pair).
public final class BridgeRouter: HTTPRouter {
    private let originPolicy: OriginPolicy
    private let sessionManager: SessionManager
    private let jobManager: JobManager
    private let bridgeVersion: String

    public init(originPolicy: OriginPolicy, sessionManager: SessionManager, jobManager: JobManager, bridgeVersion: String) {
        self.originPolicy = originPolicy
        self.sessionManager = sessionManager
        self.jobManager = jobManager
        self.bridgeVersion = bridgeVersion
    }

    public func handle(_ request: HTTPRequest) async -> HTTPResponse {
        let origin = request.header("origin")

        if request.method == "OPTIONS" {
            return corsResponse(origin: origin, status: 204, statusText: "No Content")
        }

        // Every route -- including /health -- requires an allowed Origin
        // (Part 28). No CORS header is set on a rejection, so even if a
        // disallowed page's request technically reaches this far, the
        // browser refuses to let that page's script read the response.
        guard originPolicy.isAllowed(origin: origin) else {
            return HTTPResponse.json(403, "Forbidden", ["error": "origin_not_allowed"])
        }

        let segments = request.path.split(separator: "/").map(String.init)
        let response = await route(method: request.method, segments: segments, request: request)
        return applyCORS(to: response, origin: origin)
    }

    private func route(method: String, segments: [String], request: HTTPRequest) async -> HTTPResponse {
        if method == "GET", segments == ["health"] {
            return await handleHealth()
        }
        if method == "POST", segments == ["pair"] {
            return await handlePair()
        }
        if method == "GET", segments == ["scanners"] {
            return await withSession(request) { await self.handleListScanners() }
        }
        if method == "POST", segments == ["scan"] {
            return await withSession(request) { await self.handleStartScan(request) }
        }
        if method == "GET", segments.count == 2, segments[0] == "jobs" {
            let jobId = segments[1]
            return await withSession(request) { await self.handleJobStatus(jobId: jobId) }
        }
        if method == "POST", segments.count == 3, segments[0] == "jobs", segments[2] == "cancel" {
            let jobId = segments[1]
            return await withSession(request) { await self.handleCancel(jobId: jobId) }
        }
        if method == "POST", segments.count == 3, segments[0] == "jobs", segments[2] == "finalize" {
            let jobId = segments[1]
            return await withSession(request) { await self.handleFinalize(jobId: jobId, request: request) }
        }
        if method == "GET", segments.count == 3, segments[0] == "jobs", segments[2] == "result" {
            let jobId = segments[1]
            return await withSession(request) { await self.handleResult(jobId: jobId) }
        }
        return HTTPResponse.json(404, "Not Found", ["error": "not_found"])
    }

    // MARK: - Auth

    private func withSession(_ request: HTTPRequest, _ handler: @Sendable () async -> HTTPResponse) async -> HTTPResponse {
        let authHeader = request.header("authorization")
        let token = authHeader?.hasPrefix("Bearer ") == true ? String(authHeader!.dropFirst("Bearer ".count)) : nil
        guard await sessionManager.validate(token: token) else {
            return HTTPResponse.json(401, "Unauthorized", ["error": "invalid_or_expired_session"])
        }
        return await handler()
    }

    // MARK: - Routes

    private func handleHealth() async -> HTTPResponse {
        let scanners = await jobManager.listScanners()
        let available = await jobManager.isSubsystemAvailable()
        return HTTPResponse.json(200, "OK", [
            "bridgeVersion": bridgeVersion,
            "scannerSubsystemAvailable": available,
            "scannerCount": scanners.count,
        ])
    }

    private func handlePair() async -> HTTPResponse {
        let (token, expiresIn) = await sessionManager.createSession()
        return HTTPResponse.json(200, "OK", ["sessionToken": token, "expiresInSeconds": expiresIn])
    }

    private func handleListScanners() async -> HTTPResponse {
        let scanners = await jobManager.listScanners()
        let payload = scanners.map { scanner -> [String: Any] in
            ["id": scanner.id, "name": scanner.name, "status": scanner.status.rawValue, "adfAvailable": scanner.adfAvailable]
        }
        return HTTPResponse.json(200, "OK", ["scanners": payload])
    }

    private func handleStartScan(_ request: HTTPRequest) async -> HTTPResponse {
        guard
            let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
            let scannerId = json["scannerId"] as? String, !scannerId.isEmpty
        else {
            return HTTPResponse.json(400, "Bad Request", ["error": "scannerId is required"])
        }
        let jobId = await jobManager.startScan(scannerId: scannerId)
        return HTTPResponse.json(202, "Accepted", ["jobId": jobId])
    }

    private func handleJobStatus(jobId: String) async -> HTTPResponse {
        guard let snapshot = await jobManager.snapshot(jobId: jobId) else {
            return HTTPResponse.json(404, "Not Found", ["error": "unknown_job"])
        }
        return HTTPResponse.json(200, "OK", snapshotPayload(snapshot))
    }

    private func handleCancel(jobId: String) async -> HTTPResponse {
        await jobManager.cancel(jobId: jobId)
        return HTTPResponse.json(200, "OK", ["id": jobId, "state": JobState.cancelled.rawValue])
    }

    private func handleFinalize(jobId: String, request: HTTPRequest) async -> HTTPResponse {
        guard
            let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
            let rawPages = json["pages"] as? [[String: Any]]
        else {
            return HTTPResponse.json(400, "Bad Request", ["error": "pages is required"])
        }
        var instructions: [FinalizePageInstruction] = []
        for raw in rawPages {
            guard let sourceIndex = raw["sourceIndex"] as? Int else {
                return HTTPResponse.json(400, "Bad Request", ["error": "each page needs sourceIndex"])
            }
            let rotation = (raw["rotationDegrees"] as? Int) ?? 0
            instructions.append(FinalizePageInstruction(sourceIndex: sourceIndex, rotationDegrees: rotation))
        }

        switch await jobManager.finalize(jobId: jobId, pages: instructions) {
        case .success:
            return HTTPResponse.json(200, "OK", ["id": jobId, "state": JobState.done.rawValue])
        case .failure(let error):
            return HTTPResponse.json(422, "Unprocessable Entity", ["error": error.code.rawValue, "message": error.message])
        }
    }

    private func handleResult(jobId: String) async -> HTTPResponse {
        guard let snapshot = await jobManager.snapshot(jobId: jobId), snapshot.state == .done else {
            return HTTPResponse.json(409, "Conflict", ["error": "not_ready"])
        }
        guard let data = await jobManager.resultData(jobId: jobId) else {
            return HTTPResponse.json(404, "Not Found", ["error": "result_missing"])
        }
        // The manager has now taken delivery of the final PDF -- the
        // existing web upload pipeline takes over from here, so the
        // bridge's own copy is no longer needed (Part 13: cleanup after
        // acceptance).
        await jobManager.cleanupJob(jobId)
        return HTTPResponse(status: 200, statusText: "OK", headers: ["Content-Type": "application/pdf"], body: data)
    }

    // MARK: - CORS

    private func corsResponse(origin: String?, status: Int, statusText: String) -> HTTPResponse {
        applyCORS(to: HTTPResponse(status: status, statusText: statusText), origin: origin)
    }

    private func applyCORS(to response: HTTPResponse, origin: String?) -> HTTPResponse {
        var response = response
        guard let origin, originPolicy.isAllowed(origin: origin) else { return response }
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Max-Age"] = "600"
        response.headers["Vary"] = "Origin"
        return response
    }

    private func snapshotPayload(_ snapshot: JobSnapshot) -> [String: Any] {
        var payload: [String: Any] = [
            "id": snapshot.id,
            "state": snapshot.state.rawValue,
        ]
        if let progressMessage = snapshot.progressMessage { payload["progressMessage"] = progressMessage }
        if let pageCount = snapshot.pageCount { payload["pageCount"] = pageCount }
        if let pages = snapshot.pages {
            payload["pages"] = pages.map { ["index": $0.index, "thumbnailDataUri": $0.thumbnailBase64] }
        }
        if let errorCode = snapshot.errorCode { payload["errorCode"] = errorCode.rawValue }
        if let errorMessage = snapshot.errorMessage { payload["errorMessage"] = errorMessage }
        return payload
    }
}
