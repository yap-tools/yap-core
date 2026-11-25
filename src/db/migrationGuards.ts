/**
 * Checks that run before a migration whose SQL would fail, or would have to
 * guess, on data an instance already holds. A guard looks at the data and,
 * when the migration cannot go ahead, says why and what the operator should
 * do; the migrator then applies nothing (not even the steps before it), so the
 * database stays exactly as it was. A guard never edits data itself.
 *
 * Guards are keyed by journal index, like the migrations they protect, and
 * run only while that migration is still pending. Each names the first
 * journal index its query needs (the tables or columns it reads): on a
 * database not yet that far, the data it looks for cannot exist.
 */

/** Runs one read-only SQL statement and returns its rows. */
export type RawQuery = (sql: string) => Promise<Record<string, unknown>[]>;

/** A pending migration cannot be applied to this database's data. */
export class MigrationRefused extends Error {
  constructor(tag: string, message: string) {
    super(`migration ${tag} cannot be applied: ${message}`);
    this.name = "MigrationRefused";
  }
}

interface MigrationGuard {
  /** Journal index of the migration this guard protects. */
  index: number;
  tag: string;
  /** First journal index whose schema the check's query reads. */
  needs: number;
  /** Null when the migration may go ahead, else the reason and what to do. */
  check(query: RawQuery): Promise<string | null>;
}

const GUARDS: MigrationGuard[] = [
  {
    // users.email turns from a plain index into a unique one.
    index: 19,
    tag: "0019_unique_user_email",
    needs: 17, // 0017 added users.email
    check: async (query) => {
      const rows = await query(
        "SELECT email, id FROM users WHERE email IN " +
          "(SELECT email FROM users WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1) " +
          "ORDER BY email, id",
      );
      if (rows.length === 0) return null;
      const byEmail = new Map<string, string[]>();
      for (const r of rows) {
        const email = String(r.email);
        byEmail.set(email, [...(byEmail.get(email) ?? []), String(r.id)]);
      }
      const list = [...byEmail].map(([email, ids]) => `${email} (users ${ids.join(", ")})`).join("; ");
      return (
        `a user's email is now unique, and these addresses are shared by more than one user: ${list}. ` +
        "Give all but one of each a different email or none, with the sysadmin user update " +
        '(PATCH /v1/users/<id> {"email": null}) on the version you are upgrading from, then start this version again. ' +
        "Nothing was changed."
      );
    },
  },
];

/**
 * Runs the guards of every migration that will be applied: those after the
 * `applied` count already recorded, up to and including journal index
 * `through`. Throws MigrationRefused on the first that refuses.
 */
export async function checkPendingMigrations(applied: number, through: number, query: RawQuery): Promise<void> {
  for (const guard of GUARDS) {
    if (guard.index < applied || guard.index > through) continue; // already applied, or not part of this run
    if (applied <= guard.needs) continue; // the data it checks cannot exist yet
    const refusal = await guard.check(query);
    if (refusal) throw new MigrationRefused(guard.tag, refusal);
  }
}
