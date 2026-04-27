# istoria browser logs (Chrome extension)

Chrome MV3 extension that streams console + network events from the active tab into the local istoria desktop app via its HTTP ingest endpoint.

## Install (dev)

1. Run istoria once so the daemon writes its token + port:
   - Token: `~/Library/Application Support/istoria/http.token`
   - Port: `~/Library/Application Support/istoria/http.port` (default `9787`)
2. Visit `chrome://extensions`, toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` directory.
4. Click the extension icon, paste the token, confirm port, hit **Save**.
5. Open any page, click the icon again, hit **Start capture**.

A yellow Chrome banner appears while the debugger is attached — that is unavoidable for `chrome.debugger`-based capture.

## What gets sent

Each captured tab produces two istoria sources:

- `chrome:<tab-title>` — `console.*`, uncaught exceptions, `Log.entryAdded`.
- `chrome:<tab-title>:net` — request / response / failure events.

Events are buffered and POSTed in batches every 250ms or 50 events.

## Publish (Chrome Web Store)

See the `Part 3 — Publishing` section in the design doc for the full release checklist. Quick version:

1. Bump `version` in `manifest.json`.
2. `cd extension && zip -r ../istoria-extension.zip . -x "*.DS_Store"`.
3. Upload to Chrome Web Store dev console; fill privacy policy and permission justifications (`debugger` requires both).
