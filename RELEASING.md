# Releasing

`istoria` ships via Homebrew (`dmitry-zaitsev/homebrew-tap`) using prebuilt binaries hosted on `dmitry-zaitsev/istoria-releases`. CI in this (private) source repo builds, signs, notarizes, publishes, and bumps the formula on tag push.

## One-time setup

### Repos
- Source: `dmitry-zaitsev/istoria` (this repo, private).
- Release host: `dmitry-zaitsev/istoria-releases` — public, empty (CI populates Releases).
- Tap: `dmitry-zaitsev/homebrew-tap` — public; CI writes `Formula/istoria.rb`.

### Secrets (Settings → Secrets and variables → Actions)

| Name | Purpose |
|---|---|
| `GH_RELEASES_PAT` | PAT with `repo` scope on `dmitry-zaitsev/istoria-releases` and `dmitry-zaitsev/homebrew-tap` |
| `APPLE_CERTIFICATE` | base64 of Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | Apple Developer team ID |

To produce `APPLE_CERTIFICATE`:

```sh
base64 -i developer_id.p12 | pbcopy
```

## Cutting a release

1. Bump the version in three places — they must all match:
   - `package.json` → `version`
   - `Cargo.toml` (root, `[workspace.package]`) → `version`
   - `src-tauri/tauri.conf.json` → `version`
2. Commit, push.
3. Tag and push:
   ```sh
   git tag v0.1.0
   git push origin v0.1.0
   ```
4. Watch the `Release` workflow in Actions. On success it will:
   - Upload `.tar.gz` + `SHA256SUMS` to `dmitry-zaitsev/istoria-releases` Releases as `v0.1.0`.
   - Commit `Formula/istoria.rb` to `dmitry-zaitsev/homebrew-tap`.

## Verifying

```sh
brew untap dmitry-zaitsev/tap 2>/dev/null
brew install dmitry-zaitsev/tap/istoria
echo "hello world" | istoria
```

## Dry run

`workflow_dispatch` builds without publishing when `dry_run` is true (default). Use this to validate build steps without cutting a release.

## Troubleshooting

- **Version mismatch** in pre-flight: one of the three version fields wasn't bumped.
- **Notarization timeout**: Tauri retries once; check Apple's status page. Re-run the matrix job.
- **Tap push rejected**: PAT lost `repo` scope or expired. Regenerate `GH_RELEASES_PAT`.
- **`brew install` 404**: release artifacts didn't upload. Check the `publish` job logs and the Releases page on `dmitry-zaitsev/istoria-releases`.
