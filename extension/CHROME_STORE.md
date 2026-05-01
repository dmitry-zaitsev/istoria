# Chrome Web Store listing copy

Source of truth for the dev-console fields. Copy from here when submitting.

## Name

```
istoria browser logs
```

## Short description (≤132 chars)

```
Stream browser console + network events from any tab into the local istoria desktop app over loopback.
```

## Detailed description

```
istoria browser logs forwards what your browser sees — console messages,
uncaught exceptions, and network request metadata — into the istoria
desktop application running on the same machine.

Everything stays on your computer. Events are POSTed to 127.0.0.1:9787,
the loopback address the istoria daemon listens on. No remote servers,
no analytics, no tracking.

Use it to:
• Pull live console logs out of the browser into istoria's unified log view.
• Correlate frontend errors with backend logs in the same timeline.
• Inspect network activity from any tab without keeping DevTools open.

Requires the istoria desktop app to be installed and running. Without it,
the extension stays idle — there is nothing to send to.

Open source: https://github.com/dmitry-zaitsev/istoria
```

## Category

Developer Tools

## Single purpose

```
Capture console and network events from the user's browser tabs and forward
them, over the local loopback interface, to the istoria desktop application
running on the same machine.
```

## Permission justifications

### Host permission `http://127.0.0.1/*`

```
The extension POSTs captured events to the istoria desktop app's local
HTTP ingest endpoint at http://127.0.0.1:9787/ingest. 127.0.0.1 is the
loopback address; this permission does not grant access to any remote
host. The narrow scope (http://127.0.0.1/* only) is intentional.
```

### Broad host access (`<all_urls>` in content scripts)

```
The extension installs two content scripts at document_start on every
URL the user visits so it can observe console.* calls, uncaught
exceptions, and fetch/XHR network activity from those pages. The
captured data is forwarded only to 127.0.0.1 (see above) and never
to a remote server.
```

### Remote code use

```
None. All JavaScript that runs is bundled at build time. The extension
does not load or evaluate code from remote sources.
```

### Data usage disclosures (Privacy practices tab)

| Data type           | Collected? | Notes                                       |
| ------------------- | ---------- | ------------------------------------------- |
| Personally identifiable information | No |                                             |
| Health information  | No         |                                             |
| Financial info      | No         |                                             |
| Authentication info | No         |                                             |
| Personal communications | No     |                                             |
| Location            | No         |                                             |
| Web history         | No*        | * Tab titles + URLs may appear inside captured network events but are sent only to 127.0.0.1. |
| User activity       | No*        | * Console output the page chose to print is forwarded only to 127.0.0.1. |
| Website content     | No*        | * Console + network event metadata only — never page DOM, request bodies, or response bodies. |

Certify:
- [x] I do not sell or transfer user data to third parties.
- [x] I do not use or transfer user data for purposes unrelated to the
      single purpose described above.
- [x] I do not use or transfer user data to determine creditworthiness or
      for lending purposes.

### Privacy policy URL

```
https://github.com/dmitry-zaitsev/istoria-releases/blob/main/chrome-extension/PRIVACY.md
```

Source of truth lives at `extension/PRIVACY.md` in this repo. Mirror any
edits to the public copy at
`dmitry-zaitsev/istoria-releases:chrome-extension/PRIVACY.md`.

## Submission checklist

- [ ] `npm run build` produces `../dist/istoria-extension-<version>.zip`
- [ ] `manifest.json` `version` matches `package.json` `version`
- [ ] Privacy policy hosted at a public URL
- [ ] Store icon (128×128 PNG) — same as `src/icons/icon128.png`
- [ ] At least one 1280×800 or 640×400 promo screenshot
      (`store-assets/screenshot.png` — istoria desktop app rendering
      `examples/sample_log.txt`; 2× retina copy at `screenshot-2x.png`)
- [ ] Listing copy pasted from this file
- [ ] Permission justifications pasted from this file
- [ ] Single purpose pasted from this file
