---
name: release
description: "Release the Jotter macOS/Windows/Linux app. Use whenever the user wants to publish a new version, cut a release, ship an update, bump the version, tag a build, or push a release to GitHub. Covers `pnpm release patch|minor|major`, the GitHub Actions build, publishing the draft release, and the Homebrew tap auto-update."
---

# Release Jotter

Jotter releases are **CI-based**, not built locally. One command bumps the
version everywhere, tags, and pushes; GitHub Actions builds every OS installer
and drafts a Release. You publish the draft; a second workflow updates the
Homebrew tap. The app is intentionally **unsigned / un-notarized** (no paid
Apple/Windows accounts) — there is no notarization or Sparkle step.

## The one command

```bash
pnpm release <patch|minor|major>
```

- `patch` → 0.2.0 → 0.2.1 · `minor` → 0.2.0 → 0.3.0 · `major` → 0.2.0 → 1.0.0
- Add `--dry-run` to preview the version change without writing/tagging/pushing.

The script (`scripts/release.mjs`) is non-interactive and safe to run from a tool
call. In order it:

1. **Preflights** — must be on `main` with a clean working tree; `git pull --ff-only`.
2. **Bumps the version in all four files** that hold it, in lockstep:
   `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `src/lib/meta.js` (the About screen). `cargo test` heals `Cargo.lock`.
3. **Gates on tests** — `pnpm test` (Vitest) + `cargo test`. A red suite aborts the release.
4. **Commits, tags, pushes** — `Release vX.Y.Z`, tag `vX.Y.Z`, `git push --follow-tags`.
   The **tag push** is what triggers CI.

## Full release procedure

1. **Land all code first.** Development happens on `dev`; a release ships `main`.
   Merge `dev` into `main`, make sure the working tree is clean and pushed — the
   script refuses to run off `main` or with tracked changes, so the tag points at
   exactly the released source.
2. **Pick the bump.** `patch` for fixes, `minor` for features, `major` for breaking
   changes. Never regress the version — tags are immutable once pushed.
3. **Preview if unsure:** `pnpm release patch --dry-run`.
4. **Run it:** `pnpm release <bump>`. It bumps, tests, tags, and pushes.
5. **Watch CI.** `.github/workflows/release.yml` runs the full suite (`pnpm test` +
   `cargo test`) on each OS — this is the only place the Rust tests run in CI — then
   builds macOS (universal), Windows, and Linux installers and creates a **draft**
   GitHub Release with auto-generated notes (commits since the last tag + the
   unsigned-install footer).
   ```bash
   gh run watch --repo byurhannurula/jotter
   ```
6. **Publish the draft.** Review it, then publish:
   ```bash
   gh release view --repo byurhannurula/jotter --web   # review
   gh release edit vX.Y.Z --repo byurhannurula/jotter --draft=false   # publish
   ```
7. **Homebrew tap updates itself.** Publishing fires `.github/workflows/tap.yml`,
   which hashes the DMG and pushes an updated `Casks/jotter.rb` to
   `byurhannurula/homebrew-tap`. Users then get it via `brew upgrade`.

## Verify a release

```bash
gh release view vX.Y.Z --repo byurhannurula/jotter \
  --json tagName,isDraft,assets -q '{tag:.tagName, draft:.isDraft, assets:[.assets[].name]}'
```

Expect a `.dmg` (macOS), `.exe`/`.msi` (Windows), and `.AppImage`/`.deb` (Linux),
and `isDraft: false` once published.

## Prerequisites

- `gh` (authenticated: `gh auth login`), `git`, Node 22+, pnpm, Rust stable.
- For the tap auto-update (one-time, user sets up): the `byurhannurula/homebrew-tap`
  repo must exist with `Casks/jotter.rb`, and this repo needs a `HOMEBREW_TAP_TOKEN`
  secret (a fine-grained PAT with Contents:write on the tap). Until that exists,
  skip step 7 — everything else still works.

## Notes / gotchas

- **Unsigned builds.** First launch is Gatekeeper-blocked; the release notes already
  explain the "Open Anyway" / `xattr -dr com.apple.quarantine` workaround. This is
  expected, not a bug. Do not add signing/notarization steps unless an Apple
  Developer account has been set up.
- **Draft by default.** Releases are created as drafts on purpose — nothing is public
  until you publish. If a release "isn't showing up," it's probably still a draft.
- **Re-running a version.** Tags are immutable once pushed; to redo a release, bump to
  a new patch rather than reusing a tag.
- **Auto-update (future).** When the Tauri updater ships, set `auto_updates true` in
  the cask so Homebrew and the self-updater don't conflict. See
  `docs/plan-release-automation.md` and the updater plan.
- **Design docs.** `docs/plan-release-automation.md` is the source of truth for this
  pipeline (release script + `tap.yml`); consult it if the flow needs changing.
