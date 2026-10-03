/**
 * User creation is one transaction: user + personal space + initial key all
 * land, or none do. The failure is injected at the last step (minting the
 * key), after the user and space rows have been written.
 */
import { afterEach, expect, it, vi } from "vitest";

import * as crypto from "../../src/crypto.js";
import { createUser } from "../../src/core/users.js";
import type { Db } from "../../src/db/index.js";
import { describeEachAdapter } from "../helpers/adapters.js";

vi.mock("../../src/crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/crypto.js")>();
  return { ...actual, generateAccessKey: vi.fn(actual.generateAccessKey) };
});

async function rowCounts(db: Db): Promise<{ users: number; spaces: number; keys: number }> {
  const { users, spaces, accessKeys } = db.tables;
  return {
    users: (await db.client.select().from(users)).length,
    spaces: (await db.client.select().from(spaces)).length,
    keys: (await db.client.select().from(accessKeys)).length,
  };
}

describeEachAdapter("users: atomic creation", (adapter) => {
  afterEach(() => {
    vi.mocked(crypto.generateAccessKey).mockClear();
  });

  it("a failure mid-create leaves no user, space or key behind", async () => {
    const db = await adapter.makeDb();
    try {
      await createUser(db, { name: "Survivor" });
      const before = await rowCounts(db);

      vi.mocked(crypto.generateAccessKey).mockImplementationOnce(() => {
        throw new Error("boom");
      });
      await expect(createUser(db, { name: "Doomed", externalId: "ext-doomed" })).rejects.toThrow("boom");
      expect(await rowCounts(db)).toEqual(before);

      // Nothing was left holding the externalId: the retry is a clean create.
      const retry = await createUser(db, { name: "Doomed", externalId: "ext-doomed" });
      expect("initialKey" in retry).toBe(true);
      expect(await rowCounts(db)).toEqual({
        users: before.users + 1,
        spaces: before.spaces + 1,
        keys: before.keys + 1,
      });
    } finally {
      await db.close();
    }
  });

  it("a database error on the last insert rolls the earlier ones back", async () => {
    const db = await adapter.makeDb();
    try {
      const first = await createUser(db, { name: "First" });
      const before = await rowCounts(db);

      // Reusing the first user's key collides on access_keys.key_hash.
      vi.mocked(crypto.generateAccessKey).mockReturnValueOnce(first.initialKey.key);
      await expect(createUser(db, { name: "Second" })).rejects.toThrow();
      expect(await rowCounts(db)).toEqual(before);

      // The connection is usable afterwards (no transaction left open).
      await createUser(db, { name: "Third" });
      expect((await rowCounts(db)).users).toBe(before.users + 1);
    } finally {
      await db.close();
    }
  });
});
