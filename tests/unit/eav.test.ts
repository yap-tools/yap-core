/**
 * EAV typing rules: values are stored as text with the datatype declared on
 * the property — validated on write, cast on read.
 */
import { describe, expect, it } from "vitest";

import { castValue, normalizeValue } from "../../src/core/items.js";
import { YapError } from "../../src/core/errors.js";

const prop = (datatype: string) => ({ name: "p", datatype });

describe("normalizeValue (write-time validation → stored text)", () => {
  it("text: accepts strings only", () => {
    expect(normalizeValue(prop("text"), "hello")).toBe("hello");
    expect(normalizeValue(prop("text"), "")).toBe("");
    expect(() => normalizeValue(prop("text"), 42)).toThrow(YapError);
    expect(() => normalizeValue(prop("text"), true)).toThrow(YapError);
  });

  it("number: accepts finite numbers, stores decimal text", () => {
    expect(normalizeValue(prop("number"), 42)).toBe("42");
    expect(normalizeValue(prop("number"), -3.5)).toBe("-3.5");
    expect(normalizeValue(prop("number"), 0)).toBe("0");
    expect(() => normalizeValue(prop("number"), "42")).toThrow(YapError);
    expect(() => normalizeValue(prop("number"), Number.NaN)).toThrow(YapError);
    expect(() => normalizeValue(prop("number"), Number.POSITIVE_INFINITY)).toThrow(YapError);
  });

  it("boolean: accepts booleans, stores true/false text", () => {
    expect(normalizeValue(prop("boolean"), true)).toBe("true");
    expect(normalizeValue(prop("boolean"), false)).toBe("false");
    expect(() => normalizeValue(prop("boolean"), "true")).toThrow(YapError);
    expect(() => normalizeValue(prop("boolean"), 1)).toThrow(YapError);
  });

  it("date: accepts parseable strings, normalizes to ISO-8601", () => {
    expect(normalizeValue(prop("date"), "2026-06-10T12:00:00Z")).toBe("2026-06-10T12:00:00.000Z");
    expect(normalizeValue(prop("date"), "2026-06-10")).toBe("2026-06-10T00:00:00.000Z");
    expect(() => normalizeValue(prop("date"), "not a date")).toThrow(YapError);
    expect(() => normalizeValue(prop("date"), 1718000000000)).toThrow(YapError);
  });

  it("errors name the property for actionable messages", () => {
    try {
      normalizeValue({ name: "due_date", datatype: "date" }, "nope");
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("due_date");
    }
  });
});

describe("castValue (read-time cast from stored text)", () => {
  it("casts per datatype", () => {
    expect(castValue(prop("number"), "42")).toBe(42);
    expect(castValue(prop("number"), "-3.5")).toBe(-3.5);
    expect(castValue(prop("boolean"), "true")).toBe(true);
    expect(castValue(prop("boolean"), "false")).toBe(false);
    expect(castValue(prop("text"), "hi")).toBe("hi");
    expect(castValue(prop("date"), "2026-06-10T00:00:00.000Z")).toBe("2026-06-10T00:00:00.000Z");
  });

  it("round-trips through normalize", () => {
    expect(castValue(prop("number"), normalizeValue(prop("number"), 1.25))).toBe(1.25);
    expect(castValue(prop("boolean"), normalizeValue(prop("boolean"), false))).toBe(false);
  });
});
