# Scanner Bridge HTTP Protocol

Base URL: `http://127.0.0.1:8765` (loopback only -- see SECURITY.md).
Every response includes strict CORS headers matching the request's
`Origin`, never a wildcard.

## Routes

| Method | Path                     | Auth              | Purpose |
|--------|--------------------------|-------------------|---------|
| GET    | `/health`                | Origin only       | Bridge version + subsystem availability |
| POST   | `/pair`                  | Origin only       | Mint a short-lived session token |
| GET    | `/scanners`              | Origin + session  | List discovered scanners |
| POST   | `/scan`                  | Origin + session  | Start a scan job |
| GET    | `/jobs/:id`              | Origin + session  | Poll job status (pages once captured) |
| POST   | `/jobs/:id/cancel`       | Origin + session  | Cancel an in-flight job |
| POST   | `/jobs/:id/finalize`     | Origin + session  | Assemble the final PDF from edited pages |
| GET    | `/jobs/:id/result`       | Origin + session  | Download the final PDF (once, then cleaned up) |

## `GET /health`

```json
{ "bridgeVersion": "0.1.0", "scannerSubsystemAvailable": true, "scannerCount": 1 }
```

Never includes filesystem paths, environment variables, or credentials.

## `POST /pair`

```json
{ "sessionToken": "…", "expiresInSeconds": 1800 }
```

Every subsequent request must include `Authorization: Bearer <sessionToken>`.
The token is held in memory only (never written to disk by the bridge);
the browser should hold it in memory too, not `localStorage` -- re-pair
each time the Scan Invoice flow opens.

## `GET /scanners`

```json
{ "scanners": [{ "id": "…", "name": "Canon MF741Cdw", "status": "READY", "adfAvailable": true }] }
```

`status` is one of `READY` / `BUSY` / `OFFLINE`.

## `POST /scan`

Request: `{ "scannerId": "…" }`. Response: `{ "jobId": "…" }` (202
Accepted -- the physical scan runs asynchronously; poll `/jobs/:id`).

Fixed, sensible defaults are always used -- ADF/simplex, ~300 DPI,
color, JPEG-then-PDF-assembled pages. There is no way to request
different settings through this endpoint; the manager never sees a
20-option scanner-driver dialog.

## `GET /jobs/:id`

```json
{
  "id": "…",
  "state": "PAGES_READY",
  "progressMessage": "Scan complete.",
  "pageCount": 5,
  "pages": [{ "index": 0, "thumbnailDataUri": "data:image/jpeg;base64,…" }],
  "errorCode": null,
  "errorMessage": null
}
```

`state` is one of: `STARTING`, `SCANNING`, `PROCESSING`, `PAGES_READY`,
`FINALIZING`, `DONE`, `FAILED`, `CANCELLED`. `pages`/`pageCount` are only
present once at least one page has been captured. Thumbnails are small
(downscaled, ~220px) and travel inline as base64 -- there is no separate
per-page image endpoint. `errorCode` (when `state == "FAILED"`) is one
of: `NO_DOCUMENT_LOADED`, `PAPER_JAM`, `SCANNER_BUSY`, `SCANNER_OFFLINE`,
`DEVICE_ERROR`, `TIMEOUT`, `INTERNAL_ERROR` -- never a raw
ImageCaptureCore/driver error dump.

## `POST /jobs/:id/cancel`

No body required (the bridge already knows which scanner this job
belongs to). Response: `{ "id": "…", "state": "CANCELLED" }`. Guaranteed
to leave no temporary files behind.

## `POST /jobs/:id/finalize`

The manager's edited page set -- order, rotation, and which pages to
keep (omitted pages are dropped) -- assembled into ONE PDF from the
ORIGINAL full-resolution captured pages (never from a preview
thumbnail):

```json
{ "pages": [{ "sourceIndex": 0, "rotationDegrees": 90 }, { "sourceIndex": 2, "rotationDegrees": 0 }] }
```

Response: `{ "id": "…", "state": "DONE" }`, or a 422 with a safe
`errorCode`/`message` if assembly fails.

## `GET /jobs/:id/result`

Only valid once `state == "DONE"`. Returns the final PDF bytes directly
(`Content-Type: application/pdf`). The bridge deletes its own copy of
the job (temp files + in-memory record) immediately after serving this
response -- the browser's downloaded bytes are the only remaining copy,
which it then feeds into the EXISTING Gansevoort Ops upload/finalize
pipeline exactly like a manually-selected file.

## Job lifecycle

```
STARTING -> SCANNING -> PROCESSING -> PAGES_READY -> FINALIZING -> DONE
                                          |
                                          +--> (manager cancels) --> CANCELLED
   (any step) --> FAILED
```

`PAGES_READY` is where the manager previews/edits (rotate, delete,
reorder) -- purely client-side over the returned thumbnails, no bridge
calls per edit. Nothing is uploaded to Gansevoort Ops, and no
inventory/purchase-document record is created, until the manager
explicitly accepts the finalized PDF and the EXISTING upload flow takes
over.

## Cleanup

Temporary per-job directories are removed: immediately on cancel,
immediately after `/result` is served, and by a periodic sweep (every
60s) for any job whose `lastAccessedAt` exceeds 15 minutes -- so an
abandoned scan (browser tab closed mid-preview) never lingers
indefinitely on disk.
