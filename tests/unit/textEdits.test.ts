import { describe, expect, it } from "vitest";
import { applyEdits } from "../../src/core/textEdits.js";
import { YapError } from "../../src/core/errors.js";

describe("applyEdits", () => {
  describe("prepend", () => {
    it("inserts content at the start", () => {
      expect(applyEdits("world", [{ op: "prepend", content: "hello " }])).toBe("hello world");
    });
    it("prepend with empty content is a no-op", () => {
      expect(applyEdits("world", [{ op: "prepend", content: "" }])).toBe("world");
    });
  });

  describe("append", () => {
    it("inserts content at the end", () => {
      expect(applyEdits("hello", [{ op: "append", content: " world" }])).toBe("hello world");
    });
    it("append with empty content is a no-op", () => {
      expect(applyEdits("hello", [{ op: "append", content: "" }])).toBe("hello");
    });
  });

  describe("search_replace", () => {
    it("replaces the unique match", () => {
      expect(applyEdits("foo bar foo", [{ op: "search_replace", search: "bar", replace: "baz" }])).toBe("foo baz foo");
    });
    it("errors when search string not found", () => {
      expect(() => applyEdits("hello", [{ op: "search_replace", search: "xyz", replace: "abc" }])).toThrow(YapError);
    });
    it("errors when search string matches more than once without all", () => {
      expect(() => applyEdits("foo foo", [{ op: "search_replace", search: "foo", replace: "bar" }])).toThrow(
        /more than once/,
      );
    });
    it("all: true replaces every occurrence", () => {
      expect(applyEdits("foo foo", [{ op: "search_replace", search: "foo", replace: "bar", all: true }])).toBe(
        "bar bar",
      );
    });
    it("all: true errors when search string not found", () => {
      expect(() =>
        applyEdits("hello", [{ op: "search_replace", search: "xyz", replace: "abc", all: true }]),
      ).toThrow(YapError);
    });
    it("errors on empty search string", () => {
      expect(() => applyEdits("hello", [{ op: "search_replace", search: "", replace: "x" }])).toThrow(YapError);
    });
  });

  describe("insert_before", () => {
    it("inserts content before the target", () => {
      expect(applyEdits("helloworld", [{ op: "insert_before", target: "world", content: " " }])).toBe("hello world");
    });
    it("errors when target not found", () => {
      expect(() => applyEdits("hello", [{ op: "insert_before", target: "xyz", content: " " }])).toThrow(YapError);
    });
    it("errors on empty target", () => {
      expect(() => applyEdits("hello", [{ op: "insert_before", target: "", content: " " }])).toThrow(YapError);
    });
  });

  describe("insert_after", () => {
    it("inserts content after the target", () => {
      expect(applyEdits("hello world", [{ op: "insert_after", target: "hello", content: "!" }])).toBe("hello! world");
    });
    it("errors when target not found", () => {
      expect(() => applyEdits("hello", [{ op: "insert_after", target: "xyz", content: "!" }])).toThrow(YapError);
    });
  });

  describe("delete", () => {
    it("removes the first occurrence of target", () => {
      expect(applyEdits("hello world hello", [{ op: "delete", target: "hello " }])).toBe("world hello");
    });
    it("errors when target not found", () => {
      expect(() => applyEdits("hello", [{ op: "delete", target: "xyz" }])).toThrow(YapError);
    });
    it("errors on empty target", () => {
      expect(() => applyEdits("hello", [{ op: "delete", target: "" }])).toThrow(YapError);
    });
  });

  describe("replace_lines", () => {
    const doc = "line1\nline2\nline3\nline4";
    it("replaces a range of lines", () => {
      expect(applyEdits(doc, [{ op: "replace_lines", from: 2, to: 3, content: "NEW" }])).toBe("line1\nNEW\nline4");
    });
    it("replaces with multi-line content", () => {
      expect(applyEdits(doc, [{ op: "replace_lines", from: 2, to: 2, content: "A\nB" }])).toBe(
        "line1\nA\nB\nline3\nline4",
      );
    });
    it("replaces with empty content (deletes the lines)", () => {
      expect(applyEdits(doc, [{ op: "replace_lines", from: 2, to: 3, content: "" }])).toBe("line1\nline4");
    });
    it("replaces a single line", () => {
      expect(applyEdits(doc, [{ op: "replace_lines", from: 1, to: 1, content: "FIRST" }])).toBe(
        "FIRST\nline2\nline3\nline4",
      );
    });
    it("replaces the last line", () => {
      expect(applyEdits(doc, [{ op: "replace_lines", from: 4, to: 4, content: "LAST" }])).toBe(
        "line1\nline2\nline3\nLAST",
      );
    });
    it("errors when from > to", () => {
      expect(() => applyEdits(doc, [{ op: "replace_lines", from: 3, to: 2, content: "x" }])).toThrow(YapError);
    });
    it("errors when from exceeds line count", () => {
      expect(() => applyEdits(doc, [{ op: "replace_lines", from: 5, to: 5, content: "x" }])).toThrow(
        /exceeds document length/,
      );
    });
    it("errors when to exceeds line count", () => {
      expect(() => applyEdits(doc, [{ op: "replace_lines", from: 1, to: 5, content: "x" }])).toThrow(
        /exceeds document length/,
      );
    });
  });

  describe("delete_lines", () => {
    const doc = "line1\nline2\nline3\nline4";
    it("deletes a range of lines", () => {
      expect(applyEdits(doc, [{ op: "delete_lines", from: 2, to: 3 }])).toBe("line1\nline4");
    });
    it("deletes a single line", () => {
      expect(applyEdits(doc, [{ op: "delete_lines", from: 1, to: 1 }])).toBe("line2\nline3\nline4");
    });
    it("deletes all lines", () => {
      expect(applyEdits(doc, [{ op: "delete_lines", from: 1, to: 4 }])).toBe("");
    });
    it("errors when from > to", () => {
      expect(() => applyEdits(doc, [{ op: "delete_lines", from: 3, to: 2 }])).toThrow(YapError);
    });
    it("errors when to exceeds line count", () => {
      expect(() => applyEdits(doc, [{ op: "delete_lines", from: 1, to: 5 }])).toThrow(/exceeds document length/);
    });
  });

  describe("sequential application", () => {
    it("later ops see the result of earlier ops", () => {
      const result = applyEdits("hello", [
        { op: "append", content: " world" },
        { op: "search_replace", search: "world", replace: "there" },
      ]);
      expect(result).toBe("hello there");
    });
    it("stops and throws on the first failing op", () => {
      expect(() =>
        applyEdits("hello", [
          { op: "append", content: " world" },
          { op: "search_replace", search: "missing", replace: "x" },
        ]),
      ).toThrow(/edits\[1\]/);
    });
  });

  describe("guard rails", () => {
    it("errors on empty ops array", () => {
      expect(() => applyEdits("hello", [])).toThrow(YapError);
    });
    it("errors on unknown op", () => {
      expect(() => applyEdits("hello", [{ op: "unknown_op" } as any])).toThrow(YapError);
    });
    it("error messages include the op index", () => {
      try {
        applyEdits("a", [{ op: "prepend", content: "x" }, { op: "search_replace", search: "missing", replace: "y" }]);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toContain("edits[1]");
      }
    });
  });

  describe("strict validation", () => {
    // Each op with a well-formed example; every operand key gets broken in turn.
    const valid: Record<string, Record<string, unknown>> = {
      prepend: { op: "prepend", content: "x" },
      append: { op: "append", content: "x" },
      search_replace: { op: "search_replace", search: "a", replace: "b" },
      insert_before: { op: "insert_before", target: "a", content: "x" },
      insert_after: { op: "insert_after", target: "a", content: "x" },
      delete: { op: "delete", target: "a" },
      replace_lines: { op: "replace_lines", from: 1, to: 1, content: "x" },
      delete_lines: { op: "delete_lines", from: 1, to: 1 },
    };
    const wrongType = (key: string): unknown => (key === "from" || key === "to" ? "1" : 42);

    function refusal(ops: unknown): YapError {
      try {
        applyEdits("abc", ops);
      } catch (err) {
        expect(err).toBeInstanceOf(YapError);
        expect((err as YapError).code).toBe("invalid_request");
        return err as YapError;
      }
      throw new Error("expected the edits to be refused");
    }

    for (const [name, op] of Object.entries(valid)) {
      describe(name, () => {
        it("accepts the well-formed op", () => {
          expect(() => applyEdits("abc", [op])).not.toThrow();
        });
        for (const key of Object.keys(op).filter((k) => k !== "op")) {
          it(`refuses a missing ${key}`, () => {
            const { [key]: _dropped, ...rest } = op;
            expect(refusal([rest]).message).toMatch(new RegExp(`^edits\\[0\\]: "${name}" needs ${key} \\(`));
          });
          it(`refuses a null ${key}`, () => {
            expect(refusal([{ ...op, [key]: null }]).message).toContain(`"${name}" needs ${key}`);
          });
          it(`refuses a wrong-typed ${key}`, () => {
            expect(refusal([{ ...op, [key]: wrongType(key) }]).message).toContain(`"${name}" needs ${key}`);
          });
        }
        it("refuses an unknown key, naming it and the expected shape", () => {
          const err = refusal([{ ...op, value: "x" }]);
          expect(err.message).toMatch(new RegExp(`^edits\\[0\\]: unknown key "value" for op "${name}"; expected \\{op`));
          expect(err.details).toMatchObject({ issues: [expect.objectContaining({ path: [0] })] });
        });
      });
    }

    it("names value and content for a prepend that guessed the key", () => {
      expect(refusal([{ op: "prepend", value: "x" }]).message).toBe(
        'edits[0]: unknown key "value" for op "prepend"; expected {op, content}',
      );
    });
    it("names text the same way", () => {
      expect(refusal([{ op: "append", text: "x" }]).message).toContain('unknown key "text" for op "append"');
    });
    it("shows an optional key with a ? in the expected shape", () => {
      expect(refusal([{ op: "search_replace", search: "a", replace: "b", every: true }]).message).toContain(
        "expected {op, search, replace, all?}",
      );
    });
    it("refuses a non-boolean all, and a null one", () => {
      for (const all of ["yes", null]) {
        expect(refusal([{ op: "search_replace", search: "a", replace: "b", all }]).message).toContain(
          '"search_replace" takes all as a boolean, or leave it out',
        );
      }
    });
    it("refuses zero or fractional line numbers", () => {
      expect(refusal([{ op: "delete_lines", from: 0, to: 1 }]).message).toContain("needs from (a positive integer)");
      expect(refusal([{ op: "delete_lines", from: 1, to: 1.5 }]).message).toContain("needs to (a positive integer)");
    });
    it("refuses a replace_lines without content cleanly (was a raw TypeError)", () => {
      expect(refusal([{ op: "replace_lines", from: 1, to: 1 }]).message).toContain('"replace_lines" needs content');
    });
    it("refuses an edit that is not an object", () => {
      expect(refusal(["prepend"]).message).toContain('edits[0]: each edit must be an object with an "op" field');
      expect(refusal([null]).message).toContain("edits[0]: each edit must be an object");
    });
    it("refuses a hole in a sparse array", () => {
      expect(refusal(new Array(1)).message).toContain("edits[0]: each edit must be an object");
    });
    it("refuses a non-array edits", () => {
      expect(refusal({ op: "append", content: "x" }).message).toBe("edits must be a non-empty array");
    });
    it("checks every op before applying any, and reports each bad one", () => {
      const err = refusal([
        { op: "append", content: "fine" },
        { op: "prepend", value: "x" },
        { op: "insert_after", target: "a" },
      ]);
      expect(err.message).toContain("edits[1]: unknown key");
      expect(err.message).toContain('edits[2]: "insert_after" needs content (a string)');
    });
  });
});
