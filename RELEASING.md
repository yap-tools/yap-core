# Releasing Yap

How a version gets from `main` to users. For contributing ground rules see
[CONTRIBUTING.md](CONTRIBUTING.md).

## The model in one sentence

`main` is trunk — always CI-green, **never released automatically**; a release
is a `v*` git tag, and **only tagged releases ever reach users**.

That second half is the load-bearing fact: distribution is tag-gated.
`release.yml` triggers on `push: tags: ["v*"]` and nothing else, so commits can
pile up on `main` indefinitely without touching anyone. The install one-liner
and `yap init` both pull `releases/latest` (the newest non-prerelease GitHub
Release); `yap upgrade vX.Y.Z` pins a specific tag. **Unreleased commits on
`main` are normal and safe — don't gate merges on "is this releasable".**

## Day to day (no release)

1. Branch off `main`, open a PR. CI (`ci.yml`) runs `typecheck` + the test
   suite on **both** SQLite and Postgres for every PR and every push to `main`.
2. Merge when green. Leave `package.json` `"version"` **unchanged** — it stays
   at the last released version between releases (no `-dev` suffixes).

## Cutting a release

When the accumulated commits feel like a coherent release:

1. **Pick the number.** Pre-1.0 SemVer is `0.MINOR.PATCH`:
   - **minor** (`0.6.0`) — new features; breaking changes are allowed pre-1.0.
   - **patch** (`0.5.2`) — backward-compatible fixes only.

   When in doubt, or if any API/CLI behavior changed, go minor and call it out
   in the notes.

2. **Bump `package.json`** to that version in a dedicated commit on `main`
   (`Bump version to 0.6.0` — match the existing history).

   > **The tag must equal `package.json` `"version"`.** `release.yml` runs
   > `npm pack`, which stamps the tarball from `package.json`, *not* from the
   > tag name. A mismatch ships a server that reports the wrong version and
   > makes `yap upgrade 0.6.0` fetch a tarball that disagrees with itself.
   > Bump first, then tag the bump commit.

3. **Tag and push.** Annotated tag, on the bump commit:

   ```sh
   git tag -a v0.6.0 -m "v0.6.0"
   git push origin main
   git push origin v0.6.0      # this — and only this — publishes the release
   ```

4. **Watch the `release` action.** On the tag it re-runs `npm ci && npm test`,
   then `npm pack` → `yap-core.tgz` (the full server `yap init` vendors) and
   `npm run pack:cli` → `yap-cli.tgz` (the zero-dep manager the install
   one-liner downloads), and `gh release create … --generate-notes`. A red tag
   fails the release instead of shipping — but only tag commits you know are
   green and on `main`.

Release notes are generated from merged PR/commit titles, so write titles that
read well in a changelog.

## Checklist

- [ ] All intended work merged to `main`, CI green.
- [ ] Version number chosen (minor vs patch).
- [ ] `package.json` `"version"` bumped in a `Bump version to X.Y.Z` commit.
- [ ] Annotated tag `vX.Y.Z` on that commit, **matching** `package.json`.
- [ ] `git push origin main && git push origin vX.Y.Z`.
- [ ] `release` action green; GitHub Release shows `yap-cli.tgz` + `yap-core.tgz`.

## Edge cases

- **Release candidates.** Tag `v0.6.0-rc.1` for a dry run. ⚠️ As written,
  `release.yml` does **not** pass `--prerelease`, so an `-rc` tag publishes as a
  normal release and can become `latest`. To run a real RC channel, add
  `--prerelease` to the `gh release create` step (e.g. when the tag contains a
  `-`); GitHub keeps prereleases out of `releases/latest`.
- **Hotfixing an old release.** If `main` has moved past the released commit,
  branch from the tag (`git switch -c hotfix/0.6.1 v0.6.0`), apply the fix, bump
  the patch version, tag `v0.6.1`, then merge the fix forward into `main`.
- **Never tag a commit that isn't on `main`** or hasn't passed CI.
