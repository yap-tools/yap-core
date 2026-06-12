# Security policy

Yap is a self-hosted system that holds credentials (access keys, OAuth
grants, encrypted hook secrets), so security reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, either:

- use GitHub's private vulnerability reporting on this repository
  (*Security → Report a vulnerability*), or
- email **troels@blck.dk** with a description and reproduction steps.

You should get an initial response within a few days. Please give us a
reasonable window to ship a fix before disclosing publicly.

## Scope notes for operators

- The sysadmin key and master key live in the environment (or the instance
  directory's `.env`, written mode 0600 by `yap init`). Anyone with that file
  owns the instance.
- OAuth requires `YAP_BASE_URL` to be an https origin for non-loopback
  deployments; the server warns, but does not refuse, plain http.
- Hooks deny private/link-local destinations by default and pin DNS at
  connect time; `YAP_HOOK_ALLOW_HOSTS` deliberately punches holes in that —
  use it sparingly.
