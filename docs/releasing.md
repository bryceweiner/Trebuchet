# Releasing Trebuchet

Merges to `main` are versioned by [`.github/workflows/auto-release.yml`](../.github/workflows/auto-release.yml), which computes and pushes the next `v*` tag.
Tagged releases are then built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) from a clean checkout using `npm ci`.
After the desktop artifacts are published to GitHub Releases, the same workflow publishes the npm package to GitHub Packages and uploads the static [`website/`](../website) directory to the production site. Those two jobs run only on `AnOversizedMooseWithSocks/Trebuchet`: they publish into the upstream npm scope and FTP site, so forks skip them.

## Trigger

Merge a pull request to `main`.

By default, the automation increments the patch version. Add a `minor` label to the pull request to increment the minor version, or a `major` label to increment the major version. `major` wins if both labels are present.

Pull requests run tests and Windows, Linux, and macOS arm64 package smoke builds only. The smoke builds run in parallel with tests and use `electron-builder --dir` instead of producing installer artifacts. Merges to `main` do not run the CI package matrix again; the auto-release workflow creates the tag and starts the full release build.

The tag-driven workflow can still be run manually by pushing a Git tag that starts with `v`, for example `v1.2.3`.

The workflow builds:

- macOS arm64 DMG
- macOS x64 DMG
- Windows NSIS installer
- Windows portable EXE
- Linux AppImage
- Linux deb

## Trust model

- macOS artifacts are **signed and notarized** only when both `CSC_LINK` and `CSC_KEY_PASSWORD` are present **and** one complete Apple notarization credential set is configured:
  - `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, or
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or
  - `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`.
- If the macOS credentials are absent, the workflow still builds macOS **unsigned test artifacts** and marks the release accordingly. Website download cards disclose that macOS may report unsigned downloads as damaged, and show the quarantine-removal command for users who trust the download:
  `xattr -dr com.apple.quarantine /Applications/Trebuchet.app`.
- Windows installer and portable EXE artifacts are **signed** only when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are configured.
- If the Windows credentials are absent, the workflow still builds Windows installer and portable EXE **unsigned test artifacts** and marks the release accordingly.
- Linux AppImage and deb artifacts are built as **unsigned** packages.

If any desktop artifact is published as an unsigned test artifact, the workflow marks the GitHub Release as a prerelease.

## Verification

Every release attaches `SHA256SUMS.txt`.

Verify downloads locally with:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

The release notes also state which platform artifacts were signed, notarized, unsigned, or unsigned test artifacts.

Releases the maintainer has signed also attach `SHA256SUMS.txt.sig`, an SSH signature over `SHA256SUMS.txt` by the key in [`allowed_signers`](allowed_signers). Their release notes end with a **Maintainer signature** section giving the exact commands; from a checkout of this repository:

```bash
ssh-keygen -Y verify -f docs/allowed_signers -I bryceweiner@users.noreply.github.com -n file -s SHA256SUMS.txt.sig < SHA256SUMS.txt
shasum -a 256 -c --ignore-missing SHA256SUMS.txt
```

A valid signature prints `Good "file" signature for ...`. It shows the checksums came from the maintainer; it is not macOS or Windows code signing, so the operating-system warnings described above still apply.

## Signing a release

Signing runs on the maintainer's Mac after the Release workflow has published, because the key lives in the Secure Enclave via [Secretive](https://github.com/maxgoedjen/secretive) and never reaches CI.

One-time setup:

1. In Secretive, create a secret named `Trebuchet release signing` with **Require Authentication** turned on.
2. Add its public key to [`allowed_signers`](allowed_signers) as `<git email> namespaces="file" <public key>`, and commit it.

For each release:

```bash
node scripts/sign-release.mjs v1.2.3            # check, sign, attach, add the notes section
node scripts/sign-release.mjs v1.2.3 --dry-run  # check and sign only
```

The script refuses to sign unless `SHA256SUMS.txt` matches the SHA-256 GitHub reports for every attached file, and it uploads only a signature that verifies against `docs/allowed_signers`. It authenticates with `GH_TOKEN` or `GITHUB_TOKEN`, falling back to the credential git uses for github.com.

Rerunning the Release workflow for a tag deletes `SHA256SUMS.txt.sig` along with the other stale assets, since the rebuilt checksums no longer match it, so sign that release again afterwards. When replacing the key, keep the old entry in `allowed_signers` so earlier releases still verify.

## GitHub Packages

Each tagged release publishes `@anoversizedmoosewithsocks/trebuchet-desktop` to GitHub Packages with the same version as the Git tag. If the package version already exists during a rerun, the package publish step exits successfully because npm package versions are immutable. Only the upstream repository runs this job.

## Repeatability

The workflow updates an existing release for the same tag by re-uploading current assets, deleting stale assets, and rewriting the release notes. That keeps reruns on the same `v*` tag usable after a failed or partial run.

## Website publishing

The release workflow publishes [`website/`](../website) over FTP after the GitHub Release is created. Only the upstream repository runs this job.

Required secrets:

- `FTP_LOGIN`
- `FTP_PASSWORD`

Optional repository variables:

- `FTP_HOST` (defaults to `p1401.use1.mysecurecloudhost.com`, the provider hostname whose TLS certificate covers the FTP endpoint)
- `FTP_PROTOCOL` (defaults to `ftp`)
- `FTP_REMOTE_DIR` (defaults to `.`)

Use the hosting provider's FTP hostname for `FTP_HOST`, not the public marketing domain. `makesometokens.com` serves the site, but its FTP TLS certificate is not issued for that name, so `lftp` rejects it during certificate verification.

The deploy step uploads only newer files and does not delete remote files by default.
