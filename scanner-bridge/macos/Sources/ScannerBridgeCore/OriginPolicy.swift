import Foundation

/// Strict allowed-origin checking (Part "DO NOT LET RANDOM WEBSITES USE
/// THE SCANNER" / "no wildcard Access-Control-Allow-Origin"). Every
/// route -- including /health -- rejects a request whose Origin header
/// doesn't exactly match one of these, and the CORS response header
/// echoes back only the matched origin, never `*`.
public struct OriginPolicy: Sendable {
    public let allowedOrigins: Set<String>

    public init(allowedOrigins: Set<String>) {
        self.allowedOrigins = allowedOrigins
    }

    /// Reads GANSEVOORT_SCANNER_BRIDGE_ALLOWED_ORIGINS (comma-separated)
    /// if set, otherwise defaults to local dev only. Add the real
    /// production Gansevoort Ops origin via that env var when running
    /// the bridge against a deployed app -- never hardcode it here.
    public static func fromEnvironment(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> OriginPolicy {
        if let raw = environment["GANSEVOORT_SCANNER_BRIDGE_ALLOWED_ORIGINS"], !raw.isEmpty {
            let origins = raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return OriginPolicy(allowedOrigins: Set(origins))
        }
        return OriginPolicy(allowedOrigins: ["http://localhost:3000"])
    }

    public func isAllowed(origin: String?) -> Bool {
        guard let origin else { return false }
        return allowedOrigins.contains(origin)
    }
}
