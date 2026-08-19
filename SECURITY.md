# Security policy

Yap is a self-hosted system that holds credentials (access keys, OAuth
grants, encrypted service configuration), so security reports are taken
seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, either:

- use GitHub's private vulnerability reporting on this repository
  (*Security → Report a vulnerability*), or
- email **contact@continuous.supply** with a description and reproduction steps.

You should get an initial response within a few days. Please give us a
reasonable window to ship a fix before disclosing publicly.

## Scope notes for operators

- The sysadmin key and master key live in the environment (or the instance
  directory's `.env`, written mode 0600 by `yap init`). Anyone with that file
  owns the instance.
- OAuth requires `YAP_BASE_URL` to be an https origin for non-loopback
  deployments; the server warns, but does not refuse, plain http.
- Service egress (the built-in `http` driver, and any driver that declares
  `egress: true`) denies private/link-local destinations by default and pins
  DNS at connect time; `YAP_HOOK_ALLOW_HOSTS` deliberately punches holes in
  that — use it sparingly.
- **The egress guard's threat model, stated plainly.** It defends against one
  thing: a *hostile parameter* reaching the network through an *honest*
  driver — an agent-supplied value steering a well-behaved `http` service at
  an internal address. It does not, and cannot, defend against a driver that
  was written to misbehave. A driver is trusted code running in the server
  process (`YAP_DRIVERS_DIR`, installed via `yap driver add <npm-spec>`), and
  installing one is the same class of decision as installing any other
  server-side dependency — it runs with the server's full privileges, not a
  sandboxed subset of them. We deliberately did not build static
  import/AST scanning of installed driver code to "vet" it for suspicious
  calls: a scanner an attacker can read the source of is theater, not a
  control, and it would give operators false confidence in exactly the cases
  that matter. Real isolation — a subprocess or container boundary per
  driver, with its own network namespace — is the right fix for this and is
  deferred (tracked as future work), not solved. What *is* hardened today is
  the install path itself: `yap driver add` extracts the package tarball with
  path-traversal and symlink/hardlink checks (rejecting any entry that would
  write outside the target directory), so a malicious *tarball* can't escape
  its own install folder — but that only protects the filesystem during
  install. It is not a substitute for trusting the code you're about to run;
  only install drivers from sources you'd trust with server-side code
  generally.
