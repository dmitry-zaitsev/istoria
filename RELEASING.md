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
2. Builds, signs, notarizes for `aarch64-apple-darwin`
3. Bumps `package.json` + root `Cargo.toml` + `src-tauri/tauri.conf.json` to that version, commits as `release: vX.Y.Z`, tags `vX.Y.Z`, pushes to `main`
4. Publishes the `.app.tar.gz` + `SHA256SUMS` to `dmitry-zaitsev/istoria-releases` as release `vX.Y.Z`
5. Bumps `Formula/istoria.rb` in `dmitry-zaitsev/homebrew-tap`

After the run finishes, `brew install dmitry-zaitsev/tap/istoria` installs the new version on any Apple Silicon Mac.

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

| Name | Purpose |
|---|---|
| `GH_RELEASES_PAT` | PAT with `contents: write` on `dmitry-zaitsev/istoria-releases` and `dmitry-zaitsev/homebrew-tap` |
| `APPLE_CERTIFICATE` | base64 of Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | SHA-1 of cert (or `Developer ID Application: Name (TEAMID)`) |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | Apple Developer team ID |

### Branch protection

Workflow pushes the version-bump commit + tag back to `main` using the default `GITHUB_TOKEN`. If you ever add branch protection, either grant the token bypass or move pushes to a PAT.

## Local sanity check

`just release-mac-op` runs the same sign + notarize pipeline locally (uses your login keychain + 1Password). Use it to validate signing config without burning a CI run. Does not bump versions or push anything.

## Troubleshooting

- **"tag vX.Y.Z already exists"**: the tag is taken. Re-run with `override_version` set higher, or delete the stale tag.
- **Notarization timeout**: re-run the workflow. Tauri retries once internally; persistent failures usually mean Apple is having a bad day.
- **Push to main rejected**: branch protection or token scope. See above.
- **Tap commit rejected**: PAT lost scope or expired. Regenerate `GH_RELEASES_PAT`.
- **`brew install` 404**: release artifacts didn't upload — check the publish job log on `dmitry-zaitsev/istoria-releases`.
