/**
 * An operator-facing failure: printed as one line by the CLI entry, no stack
 * trace. Lives in the instance layer so every layer that ships with the
 * manager-only CLI (cli/, instance/) and the server-side command
 * implementations (backup/run.ts) raise the same type.
 */
export class CliError extends Error {}
