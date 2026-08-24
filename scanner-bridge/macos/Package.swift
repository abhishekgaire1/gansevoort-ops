// swift-tools-version:5.10
import PackageDescription

/// The Gansevoort Scanner Bridge -- a small, isolated local helper that
/// lets the Gansevoort Ops manager web app (a Vercel-hosted Next.js app)
/// drive a local scanner on the receiving-office Mac. Deliberately NOT
/// part of the main Next.js project: it never ships to Vercel, never
/// touches Supabase directly, and never holds any server secret.
///
/// No third-party dependencies on purpose -- this is a security-sensitive
/// local HTTP server (see SECURITY.md), so the whole dependency surface
/// is Apple's own frameworks (Network, ImageCaptureCore, PDFKit,
/// Foundation), nothing fetched from the network at build time.
let package = Package(
    name: "GansevoortScannerBridge",
    platforms: [.macOS(.v13)],
    targets: [
        .target(
            name: "ScannerBridgeCore",
            path: "Sources/ScannerBridgeCore"
        ),
        .executableTarget(
            name: "gansevoort-scanner-bridge",
            dependencies: ["ScannerBridgeCore"],
            path: "Sources/gansevoort-scanner-bridge"
        ),
        // A plain executable, not a `.testTarget` -- this CommandLineTools
        // toolchain has neither XCTest nor the Testing module available
        // (only full Xcode.app ships those), so this is a small,
        // dependency-free test runner instead: `swift run
        // scanner-bridge-tests` builds it and prints PASS/FAIL per case,
        // exiting non-zero on any failure. Same fake-provider-only
        // coverage (Part 32/35/40) either way -- no real hardware, ever.
        .executableTarget(
            name: "scanner-bridge-tests",
            dependencies: ["ScannerBridgeCore"],
            path: "Sources/scanner-bridge-tests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
