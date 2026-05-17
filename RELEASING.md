# Releasing

`istoria` ships via Homebrew (`dmitry-zaitsev/homebrew-tap`) using prebuilt binaries hosted on `dmitry-zaitsev/istoria-releases`. Releases are cut by clicking a button in GitHub Actions — no local tagging, no version-bump commits, no terminal required.

Currently macOS Apple Silicon only. Intel and Linux dropped to keep CI simple; revisit if demand arises.

## Cutting a release

1. Open <https://github.com/dmitry-zaitsev/istoria/actions/workflows/release.yml>
2. Click **Run workflow**
3. Pick:
   - **bump**: `patch` (default), `minor`, or `major`
   - **override_version**: leave blank, OR set explicitly (e.g. `0.1.0` for the first release)
   - **dry_run**: leave off to ship; turn on to build-and-stop
4. Click the green **Run workflow** button. Done.

The workflow handles everything:

1. Computes next version from `package.json` (or uses your override)
2. Builds, signs, notarizes for `aarch64-apple-darwin` — produces both `istoria.app` and a branded `.dmg`
3. Ed25519-signs the wrapped `.app.tar.gz` for the in-app updater and emits `latest.json`
4. Bumps `package.json` + root `Cargo.toml` + `src-tauri/tauri.conf.json` to that version, commits as `release: vX.Y.Z`, tags `vX.Y.Z`, pushes to `main`
5. Publishes `.app.tar.gz`, `.app.tar.gz.sig`, `.dmg`, `latest.json`, and `SHA256SUMS` to `dmitry-zaitsev/istoria-releases` as release `vX.Y.Z`
6. Bumps `Formula/istoria.rb` in `dmitry-zaitsev/homebrew-tap` (formula tracks the tarball; the `.dmg` is the parallel drag-install artifact; `latest.json` powers in-app updates for DMG users)

After the run finishes:

- `brew install dmitry-zaitsev/tap/istoria` installs the new version on any Apple Silicon Mac.
- The `.dmg` on the [releases page](https://github.com/dmitry-zaitsev/istoria-releases/releases/latest) is the drag-to-Applications path for users who don't want Homebrew.
- DMG-installed apps detect the new release on next launch and offer a one-click in-app update (signature-verified, then relaunch). Homebrew installs keep using `brew upgrade` — the banner opens a Terminal with the right command.

## Verifying

```sh
brew untap dmitry-zaitsev/tap 2>/dev/null
brew install dmitry-zaitsev/tap/istoria
echo "hello world" | istoria
```

## One-time setup

### Repos

- Source: `dmitry-zaitsev/istoria` (this repo, private)
- Release host: `dmitry-zaitsev/istoria-releases` — public, empty (CI populates Releases)
- Tap: `dmitry-zaitsev/homebrew-tap` — public; CI writes `Formula/istoria.rb`

### Secrets (Settings → Secrets and variables → Actions)

| Name                                 | Purpose                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `GH_RELEASES_PAT`                    | PAT with `contents: write` on `dmitry-zaitsev/istoria-releases` and `dmitry-zaitsev/homebrew-tap` |
| `APPLE_CERTIFICATE`                  | base64 of Developer ID Application `.p12`                                                         |
| `APPLE_CERTIFICATE_PASSWORD`         | `.p12` password                                                                                   |
| `APPLE_SIGNING_IDENTITY`             | SHA-1 of cert (or `Developer ID Application: Name (TEAMID)`)                                      |
| `APPLE_ID`                           | Apple ID email                                                                                    |
| `APPLE_PASSWORD`                     | app-specific password (appleid.apple.com → Sign-In and Security)                                  |
| `APPLE_TEAM_ID`                      | Apple Developer team ID                                                                           |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of the updater private key file (see "Updater signing" below)                            |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that key                                                                             |

### Updater signing

The in-app updater (Tauri plugin) verifies downloads with an Ed25519 signature — separate from Apple notarization. Generate the keypair once:

```sh
npm run tauri -- signer generate -w ~/.tauri/istoria-updater.key
```

That writes `~/.tauri/istoria-updater.key` (private, password-protected) and `~/.tauri/istoria-updater.key.pub` (public).

- Public key → committed at `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. It's not a secret.
- Private key file contents (the single base64 line) → GitHub secret `TAURI_SIGNING_PRIVATE_KEY`. Password → `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Mirror both into 1Password (`Private/istoria release` item) so `just release-mac-op` picks them up locally.

**If the private key is ever lost** (forgotten password, leaked, ...): generate a new keypair, paste the new public key into `tauri.conf.json`, ship a new release. Every existing user must manually update once (their installed app is pinned to the old pubkey and will reject signatures from the new key). Document this hop in the release notes.

### Branch protection

Workflow pushes the version-bump commit + tag back to `main` using the default `GITHUB_TOKEN`. If you ever add branch protection, either grant the token bypass or move pushes to a PAT.

## Local sanity check

`just release-mac-op` runs the same sign + notarize pipeline locally (uses your login keychain + 1Password). Use it to validate signing config without burning a CI run. Does not bump versions or push anything. Produces the full release artifact set in `dist/`: `.app.tar.gz`, `.app.tar.gz.sig`, `.dmg`, and `latest.json`. Mount the dmg to eyeball the window layout; `cat dist/*.app.tar.gz.sig` should match the `signature` field in `dist/latest.json`.

## DMG window appearance

The Finder window that opens when a user mounts the `.dmg` is configured in `src-tauri/tauri.conf.json` under `bundle.macOS.dmg`. The background image lives at `src-tauri/icons/dmg-background.png` and is rendered from `src-tauri/icons/dmg-background.svg` at 2× (1320×800 px source for a 660×400 window).

The SVG is shape-only — no text, no fonts — so it renders identically anywhere. To re-render after editing:

```sh
just dmg-bg
```

Requires `rsvg-convert` (`brew install librsvg`).

## Troubleshooting

- **"tag vX.Y.Z already exists"**: the tag is taken. Re-run with `override_version` set higher, or delete the stale tag.
- **Notarization timeout**: re-run the workflow. Tauri retries once internally; persistent failures usually mean Apple is having a bad day.
- **Push to main rejected**: branch protection or token scope. See above.
- **Tap commit rejected**: PAT lost scope or expired. Regenerate `GH_RELEASES_PAT`.
- **`brew install` 404**: release artifacts didn't upload — check the publish job log on `dmitry-zaitsev/istoria-releases`.
- **In-app update fails with signature error**: `tauri.conf.json`'s `pubkey` no longer matches the key that signed the new release. Either you regenerated the keypair without re-shipping (existing installs are pinned to the old pubkey — they need a manual update once) or CI is using a different secret than `signer generate` produced. Verify `cat dist/*.app.tar.gz.sig` matches what's in `dist/latest.json`'s `signature` field.
