# Agent guidelines

## Commit messages

Do not mention Claude, Codex, Copilot, or any other coding agent in commit messages. No `Co-Authored-By` trailers for AI assistants, no "Generated with…" footers, no tool branding of any kind. Write commit messages as if a human authored them.

## Releasing

The release process — when and how a version ships — is documented in [RELEASING.md](RELEASING.md). Do not bump versions or push `v*` tags unless explicitly asked: tagging is what publishes a release to users. The `Bump version to X.Y.Z` commit follows the commit-message rule above.
