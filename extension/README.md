# istoria browser logs (Chrome extension)

Chrome MV3 extension that streams console + network events from a tab
you opt in to, into the local istoria desktop app via its HTTP ingest
endpoint at `http://127.0.0.1:9787/ingest`.

## Install (dev)

1. Run istoria desktop once so the daemon is listening on `127.0.0.1:9787`.
2. `cd extension && npm install && npm run build` — produces `dist/`.
3. Open `chrome://extensions`, toggle **Developer mode** (top right).
4. Click **Load unpacked** and pick the `dist/` directory.
5. Click the toolbar icon on the tab you want to capture and hit
   **Start recording**. Recording is per-tab and ends when you click
   Stop, close the tab, or navigate to a different page.

## What gets sent

Each tab produces two istoria sources:

- `chrome:<tab-title>` — `console.*`, uncaught exceptions.
- `chrome:<tab-title>:net` — request / response / failure events.

Events are buffered and POSTed in batches every 250 ms or 50 events. Only
metadata is sent (URL, method, status, timing, console message text) —
never request or response bodies.

## Build

```
npm run build
```

Outputs:

- `extension/dist/` — unpacked extension (load this in dev mode).
- `dist/istoria-extension-<version>.zip` (sibling of `extension/`) —
  ready to upload to the Chrome Web Store.

## Icon

Shares the istoria desktop app icon. Source:
`src-tauri/icons/source.svg`. Re-rasterize after changes:

```
for s in 16 32 48 128; do
  rsvg-convert -w $s -h $s ../src-tauri/icons/source.svg \
    -o src/icons/icon$s.png
done
```

## Publish (Chrome Web Store)

1. Bump `version` in **both** `manifest.json` and `package.json` to the
   same value.
2. `npm run build`.
3. Upload `../dist/istoria-extension-<version>.zip` in the
   [Chrome Web Store dev console](https://chrome.google.com/webstore/devconsole).
4. Paste listing copy + permission justifications from
   [`CHROME_STORE.md`](CHROME_STORE.md).
5. Host [`PRIVACY.md`](PRIVACY.md) at a public URL and paste it under
   "Privacy policy".
6. Submit for review.
