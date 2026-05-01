# Privacy policy — istoria browser logs

_Last updated: 2026-05-01_

## What this extension does

`istoria browser logs` captures browser console output (`console.log`,
`console.warn`, `console.error`, uncaught exceptions) and network request
metadata (URL, method, status, timing, response size) from pages the user
visits. It forwards those events to the istoria desktop application, which
runs on the same machine and listens on `http://127.0.0.1:9787`.

## What data is collected

- **Console events** — message text and level. Messages may contain anything
  the page chose to log, including object data the page printed.
- **Network events** — request URL, method, response status, timing, response
  size. Request and response bodies are **not** captured.
- **Tab title** — used to label the source stream inside istoria.

## Where the data goes

- **Only to the local machine.** All captured events are POSTed to
  `http://127.0.0.1:9787/ingest`, which is the loopback address. No data
  leaves the user's computer through this extension.
- **No remote servers.** The extension does not contact any service operated
  by the extension author or any third party.
- **No analytics, no telemetry.** The extension does not measure or report
  usage.
- **No persistent storage.** The extension does not store captured events.
  Buffered events live in memory inside the service worker until they are
  flushed (every 250 ms or 50 events) and are then discarded.

## Who can read the data

Only software running on the user's machine that listens on
`127.0.0.1:9787` — in practice, the istoria desktop app the user installed.

## Permissions

- `host_permissions: http://127.0.0.1/*` — required to POST captured events
  to the local istoria daemon.
- `activeTab` + `scripting` — required to inject the capture scripts into
  the current tab when the user clicks **Start recording** in the popup.
  Capture is per-tab and opt-in. Nothing runs on a tab until the user
  explicitly starts recording it; recording ends on Stop, tab close, or
  navigation.

## Contact

dz@wallspaghetti.com
