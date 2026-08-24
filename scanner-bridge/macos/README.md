# Gansevoort Scanner Bridge

A small, local-only macOS helper that lets the Gansevoort Ops manager web
app (`/manager/receiving`) drive a scanner connected to the receiving
office Mac. It is a completely separate Swift package from the Next.js
app -- it never ships to Vercel, never talks to Supabase, and never
holds any server secret (see [SECURITY.md](./SECURITY.md)).

```
Gansevoort Ops browser  <-->  127.0.0.1:8765 (this bridge)  <-->  ImageCaptureCore  <-->  Canon MF741Cdw
```

## Requirements

- macOS with Xcode or the Xcode Command Line Tools (`xcode-select --install`)
- No other dependencies -- this package fetches nothing from the network
  at build time.

## Build

```sh
cd scanner-bridge/macos
swift build
```

## Run

Real hardware (default):

```sh
swift run gansevoort-scanner-bridge
```

Fake/dev provider (no hardware required -- five simulated scenarios, see
`FakeScannerProvider.swift`):

```sh
GANSEVOORT_SCANNER_PROVIDER=fake swift run gansevoort-scanner-bridge
```

The bridge binds to `127.0.0.1:8765` only. Override the port with
`GANSEVOORT_SCANNER_BRIDGE_PORT`. Add a deployed production origin (in
addition to `http://localhost:3000`, which is always allowed) with:

```sh
GANSEVOORT_SCANNER_BRIDGE_ALLOWED_ORIGINS="http://localhost:3000,https://your-deployed-origin" swift run gansevoort-scanner-bridge
```

Stop it with Ctrl-C (SIGINT) -- it cleans up every temporary scan file it
created before exiting.

## Hardware diagnostics (run this on the real receiving-office Mac)

Enumerates scanners and prints only safe device info (name, status, ADF
availability). **Never scans** unless you explicitly pass `--test-scan`.

```sh
swift run gansevoort-scanner-bridge -- --diagnostics
```

To also run one real test scan against a specific discovered device id
(only do this once you've loaded a real sheet of paper and want to
verify an actual scan works):

```sh
swift run gansevoort-scanner-bridge -- --diagnostics --test-scan <scannerId>
```

If `scannerCount` is 0 and the Canon MF741Cdw is connected and powered
on, that means ImageCaptureCore (via the currently installed macOS/Canon
driver) cannot see it. **Stop there and report it** -- do not assume a
software fix will make it appear; this is a hardware/driver
compatibility boundary, not something this bridge's code controls.

## Run the test suite

No real scanner required -- everything runs against `FakeScannerProvider`.
This toolchain's Xcode Command Line Tools don't include XCTest/Testing,
so this is a small dependency-free runner instead of `swift test`:

```sh
swift run scanner-bridge-tests
```

## Architecture

- `Sources/ScannerBridgeCore/` -- the library. `ScannerProvider` is the
  hardware abstraction (`FakeScannerProvider` for dev/tests,
  `MacImageCaptureScannerProvider` for the real Canon via
  ImageCaptureCore). `JobManager` owns the scan-job lifecycle, temp
  files, and cleanup. `HTTPServer`/`BridgeRouter` are a minimal,
  dependency-free HTTP/1.1 server bound to loopback only.
- `Sources/gansevoort-scanner-bridge/` -- the executable entry point
  (`main.swift`): starts the server, or runs `--diagnostics`.
- `Sources/scanner-bridge-tests/` -- the test runner executable.

## Protocol

See [PROTOCOL.md](./PROTOCOL.md) for the full HTTP contract (routes,
job states, error codes) and [SECURITY.md](./SECURITY.md) for the
auth/origin model.
