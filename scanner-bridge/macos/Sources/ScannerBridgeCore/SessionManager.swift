import Foundation
import Security

/// Short-lived pairing/session tokens (Part "BROWSER <-> BRIDGE
/// AUTHENTICATION"): minted fresh on every /pair call, held only in
/// memory (never written to disk, never a fixed/long-lived secret baked
/// into the helper), and required on every state-changing/data-bearing
/// route via `Authorization: Bearer <token>`. Combined with strict
/// Origin checking (see OriginPolicy.swift) -- neither is sufficient
/// alone; a malicious page can't get a token without passing the Origin
/// check, and a stolen/replayed request without a valid token is
/// rejected regardless of Origin.
public actor SessionManager {
    private struct Session {
        let expiresAt: Date
    }

    private var sessions: [String: Session] = [:]
    private let lifetime: TimeInterval

    public init(lifetime: TimeInterval = 30 * 60) {
        self.lifetime = lifetime
    }

    public func createSession() -> (token: String, expiresInSeconds: Int) {
        let token = Self.randomToken()
        let expiresAt = Date().addingTimeInterval(lifetime)
        sessions[token] = Session(expiresAt: expiresAt)
        return (token, Int(lifetime))
    }

    /// Validates a bearer token and, if valid, slides its expiry forward
    /// -- a real scan can legitimately take a few minutes across
    /// scan+preview+finalize, and the manager shouldn't be silently
    /// logged out of the bridge mid-workflow.
    public func validate(token: String?) -> Bool {
        guard let token, let session = sessions[token] else { return false }
        guard session.expiresAt > Date() else {
            sessions[token] = nil
            return false
        }
        sessions[token] = Session(expiresAt: Date().addingTimeInterval(lifetime))
        return true
    }

    public func sweepExpired() {
        let now = Date()
        sessions = sessions.filter { $0.value.expiresAt > now }
    }

    private static func randomToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let result = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        precondition(result == errSecSuccess, "SecRandomCopyBytes failed")
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
