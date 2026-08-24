import Foundation
import Network

public struct HTTPRequest: Sendable {
    public let method: String
    public let path: String
    public let query: [String: String]
    public let headers: [String: String] // lowercased keys
    public let body: Data

    public init(method: String, path: String, query: [String: String], headers: [String: String], body: Data) {
        self.method = method
        self.path = path
        self.query = query
        self.headers = headers
        self.body = body
    }

    public func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

public struct HTTPResponse: Sendable {
    public var status: Int
    public var statusText: String
    public var headers: [String: String]
    public var body: Data

    public init(status: Int, statusText: String, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status
        self.statusText = statusText
        self.headers = headers
        self.body = body
    }

    public static func json(_ status: Int, _ statusText: String, _ object: Any, headers: [String: String] = [:]) -> HTTPResponse {
        let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        var allHeaders = headers
        allHeaders["Content-Type"] = "application/json"
        return HTTPResponse(status: status, statusText: statusText, headers: allHeaders, body: body)
    }
}

public protocol HTTPRouter: Sendable {
    func handle(_ request: HTTPRequest) async -> HTTPResponse
}

/// A minimal, dependency-free HTTP/1.1 server bound to 127.0.0.1 only
/// (Part "LOCAL-ONLY SECURITY": "Bind only to 127.0.0.1, not 0.0.0.0").
/// One request per connection (no keep-alive/pipelining) -- this bridge
/// only ever serves small JSON responses and one PDF download at a time
/// to a single local browser tab polling over loopback, so the
/// simplicity is worth it over pulling in a general-purpose HTTP
/// framework (Part 4: "Keep the local helper small").
public final class HTTPServer: @unchecked Sendable {
    private let router: HTTPRouter
    private let port: UInt16
    private var listener: NWListener?

    public init(router: HTTPRouter, port: UInt16) {
        self.router = router
        self.port = port
    }

    public func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [router] connection in
            let handler = ConnectionHandler(connection: connection, router: router)
            handler.start()
        }
        listener.start(queue: .global(qos: .userInitiated))
        self.listener = listener
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }
}

/// Owns one accepted connection's lifetime -- keeps itself alive via a
/// strong self-reference in its closures until the response is fully
/// written, then releases.
private final class ConnectionHandler: @unchecked Sendable {
    private let connection: NWConnection
    private let router: HTTPRouter
    private var buffer = Data()
    private var selfRetain: ConnectionHandler?
    private static let maxRequestBytes = 4 * 1024 * 1024 // generous ceiling for a small JSON body; never a file upload

    init(connection: NWConnection, router: HTTPRouter) {
        self.connection = connection
        self.router = router
    }

    func start() {
        selfRetain = self
        connection.start(queue: .global(qos: .userInitiated))
        receiveMore()
    }

    private func receiveMore() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                if self.buffer.count > Self.maxRequestBytes {
                    self.writeAndClose(HTTPResponse(status: 413, statusText: "Payload Too Large"))
                    return
                }
                if let request = self.tryParseRequest() {
                    Task {
                        let response = await self.router.handle(request)
                        self.writeAndClose(response)
                    }
                    return
                }
            }
            if isComplete || error != nil {
                self.finish()
                return
            }
            self.receiveMore()
        }
    }

    private func tryParseRequest() -> HTTPRequest? {
        guard let headerEndRange = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headerData = buffer.subdata(in: buffer.startIndex..<headerEndRange.lowerBound)
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }
        let lines = headerText.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let requestParts = requestLine.split(separator: " ", maxSplits: 2)
        guard requestParts.count >= 2 else { return nil }
        let method = String(requestParts[0])
        let rawTarget = String(requestParts[1])

        var headers: [String: String] = [:]
        for line in lines.dropFirst() where !line.isEmpty {
            guard let colonIndex = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colonIndex].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colonIndex)...].trimmingCharacters(in: .whitespaces)
            headers[name] = value
        }

        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = headerEndRange.upperBound
        let availableBodyBytes = buffer.count - buffer.distance(from: buffer.startIndex, to: bodyStart)
        guard availableBodyBytes >= contentLength else { return nil } // wait for more data

        let body = contentLength > 0 ? buffer.subdata(in: bodyStart..<buffer.index(bodyStart, offsetBy: contentLength)) : Data()

        let (path, query) = Self.splitTarget(rawTarget)
        return HTTPRequest(method: method, path: path, query: query, headers: headers, body: body)
    }

    private static func splitTarget(_ target: String) -> (path: String, query: [String: String]) {
        guard let questionIndex = target.firstIndex(of: "?") else { return (target, [:]) }
        let path = String(target[target.startIndex..<questionIndex])
        let queryString = target[target.index(after: questionIndex)...]
        var query: [String: String] = [:]
        for pair in queryString.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard let key = parts.first else { continue }
            let value = parts.count > 1 ? String(parts[1]) : ""
            query[String(key).removingPercentEncoding ?? String(key)] = value.removingPercentEncoding ?? value
        }
        return (path, query)
    }

    private func writeAndClose(_ response: HTTPResponse) {
        var raw = Data("HTTP/1.1 \(response.status) \(response.statusText)\r\n".utf8)
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count)
        headers["Connection"] = "close"
        for (name, value) in headers {
            raw.append(Data("\(name): \(value)\r\n".utf8))
        }
        raw.append(Data("\r\n".utf8))
        raw.append(response.body)

        connection.send(
            content: raw,
            completion: .contentProcessed { [weak self] _ in
                self?.finish()
            }
        )
    }

    private func finish() {
        connection.cancel()
        selfRetain = nil
    }
}
