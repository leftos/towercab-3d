# macOS code signing & notarization setup

Signing and notarizing the macOS `.dmg`/`.app` lets it launch without Gatekeeper's
"damaged and can't be opened" warning, so Mac users no longer need the
`xattr -dr com.apple.quarantine` workaround. This is a **one-time setup** of
GitHub Actions secrets — no code changes to your machine, and the Apple
credentials are reused from the `yaat` repo (see "Reuse from yaat" below).

**Status:** Not yet wired into CI. `release-macos.yml` currently builds an
**unsigned, un-notarized** Apple Silicon `.dmg`. This doc is the setup guide;
section 5 contains the workflow changes still to be applied.

Tauri signs and notarizes during `tauri build` (via `tauri-action`) entirely
through environment variables — there is no per-app Apple asset to create. It
produces a `.dmg` and `.app`, **not** a `.pkg`, so unlike yaat you only need the
Developer ID **Application** certificate (no Installer cert).

## What the pipeline expects

Once wired in, `release-macos.yml` reads these secrets. If `APPLE_CERTIFICATE`
is empty the signing path is skipped and the build stays unsigned, so forks (and
this repo before setup) still produce a working — if quarantined — `.dmg`.

| Secret | What it is |
|--------|------------|
| `APPLE_CERTIFICATE` | Developer ID **Application** cert + private key, as a base64-encoded `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | The password protecting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The Application cert's name, e.g. `Developer ID Application: Jane Doe (AB12CD34EF)` |
| `APPLE_API_KEY_P8_BASE64` | App Store Connect API key (`.p8`), base64-encoded (decoded to a file in CI) |
| `APPLE_API_KEY` | The API key's Key ID (10 chars, e.g. `2X9R4HXF34`) |
| `APPLE_API_ISSUER` | The API key's Issuer ID (a UUID) |
| `KEYCHAIN_PASSWORD` | Any random string; protects the throwaway CI keychain |

`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH` select the App Store
Connect API-key notarization method (a JWT key, more robust than an Apple-ID +
app-specific password). `APPLE_API_KEY_PATH` is set inside the workflow after
decoding `APPLE_API_KEY_P8_BASE64` to a file — it is not a secret.

## Reuse from yaat

The Apple credentials are account-level, not app-specific — the **same**
Developer ID Application certificate and App Store Connect notary key that
`leftos/yaat` uses work here unchanged. GitHub secrets are per-repo and
write-only, though, so they must be **re-added** to `leftos/towercab-3d` with
Tauri's names:

| TowerCab 3D secret | Same value as yaat's |
|--------------------|----------------------|
| `APPLE_CERTIFICATE` | `MACOS_DEVID_APP_CERT_P12_BASE64` |
| `APPLE_CERTIFICATE_PASSWORD` | `MACOS_DEVID_CERT_PASSWORD` |
| `APPLE_SIGNING_IDENTITY` | `MACOS_SIGN_APP_IDENTITY` |
| `APPLE_API_KEY_P8_BASE64` | `MACOS_NOTARY_API_KEY_P8_BASE64` |
| `APPLE_API_KEY` | `MACOS_NOTARY_API_KEY_ID` |
| `APPLE_API_ISSUER` | `MACOS_NOTARY_API_ISSUER_ID` |

**Not needed here:** yaat's Developer ID *Installer* cert
(`MACOS_DEVID_INSTALLER_CERT_P12_BASE64`) and `MACOS_SIGN_INSTALL_IDENTITY` —
those sign a `.pkg`, which Tauri doesn't produce.

You know the identity string, Key ID, Issuer ID, and `.p12` password by hand.
For the two base64 blobs you need the source files again: the `.p12` can be
re-exported from your Mac's login keychain anytime (Keychain Access → My
Certificates → the "Developer ID Application: …" row); if you deleted the `.p8`,
generate a fresh App Store Connect key (the cert and identity are unaffected).
Full cert/key creation steps are in `yaat/docs/macos-code-signing.md` §§1–3.

## Step 1 — Export the Developer ID Application certificate (on a Mac)

In **Keychain Access**, login keychain, **My Certificates**: expand the
**"Developer ID Application: …"** row so both the certificate and its private key
are selected → right-click → **Export 2 items…** → format **Personal Information
Exchange (.p12)** → save as `devid_app.p12`, set a password.

Capture the exact identity string:

```bash
security find-identity -v -p codesigning   # e.g. "Developer ID Application: Jane Doe (AB12CD34EF)"
```

## Step 2 — Obtain the App Store Connect API key

Reuse the existing `.p8` if you still have it. Otherwise create a fresh one at
<https://appstoreconnect.apple.com/access/integrations/api> → **Team Keys** →
**+** → **Developer** access → **Generate** → download the
`AuthKey_XXXXXXXXXX.p8` (downloadable once). Note the **Key ID** (`XXXXXXXXXX`)
and the **Issuer ID** (UUID above the table).

## Step 3 — Base64-encode the two files

```bash
base64 -i devid_app.p12         -o devid_app.p12.b64
base64 -i AuthKey_XXXXXXXXXX.p8  -o notary_key.p8.b64
```

## Step 4 — Add the secrets to GitHub

From a checkout of `leftos/towercab-3d`, with `gh` authenticated:

```bash
gh secret set APPLE_CERTIFICATE          < devid_app.p12.b64
gh secret set APPLE_API_KEY_P8_BASE64    < notary_key.p8.b64

gh secret set APPLE_CERTIFICATE_PASSWORD   # paste the .p12 password
gh secret set APPLE_SIGNING_IDENTITY       # paste "Developer ID Application: …"
gh secret set APPLE_API_KEY                # paste the 10-char Key ID
gh secret set APPLE_API_ISSUER             # paste the Issuer UUID
gh secret set KEYCHAIN_PASSWORD            # paste any random string
```

Then delete the local `.p12`, `.p8`, and `.b64` files — they are signing
credentials:

```bash
rm devid_app.p12 AuthKey_*.p8 *.b64
```

## Step 5 — Wire signing into `release-macos.yml` (still to be applied)

Add a certificate-import step and a notary-key step before the `tauri-action`
build, then pass the `APPLE_*` env vars to it. Gate the import on
`APPLE_CERTIFICATE` so the unsigned path still works for forks.

```yaml
      - name: Import Apple Developer certificate
        id: apple-signing
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
          APPLE_API_KEY_P8_BASE64: ${{ secrets.APPLE_API_KEY_P8_BASE64 }}
        run: |
          set -euo pipefail
          if [ -z "$APPLE_CERTIFICATE" ]; then
            echo "::warning::Apple signing secrets not set — building an UNSIGNED, un-notarized dmg."
            echo "enabled=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          keychain="$RUNNER_TEMP/build.keychain-db"
          echo -n "$APPLE_CERTIFICATE" | base64 --decode -o "$RUNNER_TEMP/cert.p12"
          echo -n "$APPLE_API_KEY_P8_BASE64" | base64 --decode -o "$RUNNER_TEMP/notary_key.p8"
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
          security set-keychain-settings -lut 21600 "$keychain"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$keychain"
          security import "$RUNNER_TEMP/cert.p12" -P "$APPLE_CERTIFICATE_PASSWORD" \
            -A -t cert -f pkcs12 -k "$keychain"
          security set-key-partition-list -S apple-tool:,apple: -k "$KEYCHAIN_PASSWORD" "$keychain" >/dev/null
          security list-keychain -d user -s "$keychain"
          rm -f "$RUNNER_TEMP/cert.p12"
          echo "enabled=true" >> "$GITHUB_OUTPUT"
          echo "APPLE_API_KEY_PATH=$RUNNER_TEMP/notary_key.p8" >> "$GITHUB_ENV"
```

Then add to the **`Build Tauri app (with signing)`** step's `env:` block:

```yaml
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_PATH: ${{ env.APPLE_API_KEY_PATH }}
```

Tauri enables the hardened runtime automatically when signing (required for
notarization), then uploads the API key, polls Apple, and staples the ticket to
the `.dmg`. No `tauri.conf.json` change is needed: the `.dmg` already builds, and
a standard Tauri app notarizes with no custom entitlements.

## Step 6 — Entitlements (only if the converter fails)

The bundled `fsltl_converter` is a PyInstaller binary, which can fail to launch
under the hardened runtime. If a notarized build can't run the FSLTL/AIG
converter, add `src-tauri/Entitlements.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

and reference it from `tauri.conf.json` → `bundle.macOS.entitlements`. Ship
without it first; add it only if needed.

## Step 7 — Verify

Cut a release (`/prepare-release` → tag push). On a Mac, sanity-check the
downloaded `.dmg`:

```bash
spctl --assess -vvv --type open /Volumes/.../TowerCab\ 3D.app   # → "accepted, source=Notarized Developer ID"
xcrun stapler validate "TowerCab.3D_<ver>_aarch64.dmg"          # → "The validate action worked!"
```

## Step 8 — Remove the unsigned workaround note

Once a notarized build is verified, drop the "damaged / `xattr -dr
com.apple.quarantine`" guidance from `release.yml`'s release body, the
`prepare-release` skill's notes footer, and README/USER_GUIDE — those instruct
users around a problem that no longer exists.

## Maintenance notes

- **Apple code signing is independent of the auto-updater.** The updater uses
  minisign (`TAURI_SIGNING_PRIVATE_KEY`); keep it. Notarization does not replace
  it.
- **Apple Silicon only.** The matrix builds `aarch64-apple-darwin`. Reusing the
  cert for an `x86_64-apple-darwin` target is trivial if Intel support is added
  later.
- **The Developer ID certificate expires after 5 years.** On renewal, re-export
  the `.p12` and update `APPLE_CERTIFICATE` (and `APPLE_SIGNING_IDENTITY` if the
  team suffix changes).
