# Releasing Yap

How a version gets from `main` to users. For contributing ground rules see
[CONTRIBUTING.md](CONTRIBUTING.md).

## The model in one sentence

`main` is trunk — always CI-green, **never released automatically**; a release
is a `v*` git tag, and **only tagged releases ever reach users**. A release
needs no merge and no release branch: tagging is the whole event. The one
exception is a hotfix to an older release (see [Hotfixes](#hotfixes)).

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

## Branches

- **`main`** is the only standing branch. All work lands on it through PRs.
- **`release/MAJOR.MINOR`** exists only when a hotfix needs it (below). It is
  cut from a release tag, kept while that minor version is supported, and
  never merged back into `main` as a whole.

A standing `dev` branch, with releases merged into `main`, is not used: every
hotfix would have to be merged back into `dev` by hand.

## Hotfixes

A hotfix is a fix to something already released. Where it goes depends on
whether `main` has moved since the tag.

**`main` has not moved since the tag** (`git rev-list v0.8.0..main` is empty).
Fix on `main` through a PR, then bump and tag from `main` as in
[Cutting a release](#cutting-a-release). No release branch.

**`main` has moved on.** Fixing on `main` would ship unreleased work, so the
fix goes on a release branch cut from the tag. Example: `v0.8.0` needs a fix
and `main` is already past it.

1. Create `release/0.8` from the release tag, or reuse it if it exists:

   ```sh
   git fetch origin --tags
   git switch -c release/0.8 v0.8.0       # first hotfix on this minor
   git push -u origin release/0.8
   # later hotfixes: git switch release/0.8 && git pull
   ```

2. Fix on a branch off it and open a PR against `release/0.8` (CI runs on
   every PR, whatever its base):

   ```sh
   git switch -c fix/some-bug release/0.8
   # commit, push, open the PR with base release/0.8
   ```

3. After it merges, bump `package.json` to the next patch on the release
   branch (`Bump version to 0.8.1`), then tag that commit. The tag must still
   equal `package.json` `"version"`:

   ```sh
   git switch release/0.8 && git pull
   git tag -a v0.8.1 -m "v0.8.1"
   git push origin v0.8.1
   ```

4. Cherry-pick the fix onto `main` through its own PR, so the next release
   from `main` carries it. Do not cherry-pick the version bump.

   ```sh
   git switch -c fix/some-bug-main main
   git cherry-pick <sha-of-the-fix>
   # push, open the PR against main
   ```

`release.yml` runs on any `v*` tag, so it publishes a tag from a release
branch the same way as one from `main`. Note that `releases/latest` is the
newest non-prerelease GitHub Release by date: tagging `v0.8.1` after `v0.9.0`
may make `0.8.1` the install default. Check the Release page after a hotfix.

## Checklist

- [ ] All intended work merged to `main`, CI green.
- [ ] Version number chosen (minor vs patch).
- [ ] `package.json` `"version"` bumped in a `Bump version to X.Y.Z` commit.
- [ ] Annotated tag `vX.Y.Z` on that commit, **matching** `package.json`.
- [ ] `git push origin main && git push origin vX.Y.Z`.
- [ ] `release` action green; GitHub Release shows `yap-cli.tgz` + `yap-core.tgz`.

For a hotfix on a release branch, the same list applies with `release/X.Y` in
place of `main`, plus the cherry-pick PR onto `main`.

## Edge cases

- **Release candidates.** Tag `v0.6.0-rc.1` for a dry run. ⚠️ As written,
  `release.yml` does **not** pass `--prerelease`, so an `-rc` tag publishes as a
  normal release and can become `latest`. To run a real RC channel, add
  `--prerelease` to the `gh release create` step (e.g. when the tag contains a
  `-`); GitHub keeps prereleases out of `releases/latest`.
- **Never tag a commit** that is not on `main` or a `release/X.Y` branch, or
  that has not passed CI.
- **Tags other than `vX.Y.Z`.** Release tags are `vMAJOR.MINOR.PATCH`,
  annotated, and nothing else.
