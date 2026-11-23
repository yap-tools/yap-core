/**
 * The strict date-input parser: a bare day or a zoned timestamp, nothing else,
 * and the same stored instant whatever the server's own time zone is.
 */
import { afterEach, describe, expect, it } from "vitest";

import { DATE_INPUT_HINT, DAY_INPUT_HINT, parseDateInput, parseDayInput } from "../../src/core/dates.js";
import { validatePropertyConfig } from "../../src/core/propertyConfig.js";

const ACCEPTED: [string, string][] = [
  ["2026-11-16", "2026-11-16T00:00:00.000Z"],
  ["2026-11-16T09:00:00+01:00", "2026-11-16T08:00:00.000Z"],
  ["2026-11-16T08:00:00Z", "2026-11-16T08:00:00.000Z"],
  ["2026-11-16T08:00Z", "2026-11-16T08:00:00.000Z"],
  ["2026-11-16T08:00:00.5Z", "2026-11-16T08:00:00.500Z"],
  ["2026-11-16T08:00:00.123456Z", "2026-11-16T08:00:00.123Z"],
  ["2026-11-16T03:30:00-05:30", "2026-11-16T09:00:00.000Z"],
  ["2026-11-16T08:00:00-00:00", "2026-11-16T08:00:00.000Z"],
  ["2026-11-16T00:30:00+01:00", "2026-11-15T23:30:00.000Z"],
  ["2024-02-29", "2024-02-29T00:00:00.000Z"],
  ["2000-02-29T12:00:00Z", "2000-02-29T12:00:00.000Z"],
  ["0099-01-01", "0099-01-01T00:00:00.000Z"],
  ["0000-01-01T01:00:00+01:00", "0000-01-01T00:00:00.000Z"],
  ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
];

const REFUSED = [
  // zoneless: read in the server's local time by Date.parse
  "2026-11-16T09:00:00",
  "2026-11-16T09:00",
  // other forms Date.parse takes
  "Nov 16, 2026",
  "2026/11/16",
  "Mon, 16 Nov 2026 09:00:00 GMT",
  "2026",
  "2026-11",
  "+002026-11-16",
  "2026-11-16 09:00:00Z",
  "2026-11-16t09:00:00z",
  "2026-11-16T09:00:00+0100",
  "2026-11-16T09:00:00+01",
  "20261116",
  " 2026-11-16",
  "2026-11-16\n",
  // impossible dates and times in an accepted form
  "2026-02-30",
  "2026-02-29",
  "1900-02-29",
  "2026-13-01",
  "2026-00-10",
  "2026-04-31",
  "2026-11-00",
  "2026-11-16T24:00:00Z",
  "2026-11-16T09:60:00Z",
  "2026-11-16T09:00:60Z",
  "2026-11-16T09:00:00+24:00",
  "2026-11-16T09:00:00+01:60",
  // an offset that carries the instant outside years 0000-9999
  "0000-01-01T00:00:00+01:00",
  "9999-12-31T23:30:00-01:00",
  "",
  "not a date",
];

describe("parseDateInput", () => {
  it.each(ACCEPTED)("accepts %s as %s", (input, stored) => {
    expect(parseDateInput(input)).toBe(stored);
  });

  it.each(REFUSED)("refuses %j", (input) => {
    expect(parseDateInput(input)).toBeNull();
  });

  it("refuses anything that is not a string", () => {
    for (const v of [1718000000000, null, undefined, true, {}, ["2026-11-16"], new Date(0)]) {
      expect(parseDateInput(v)).toBeNull();
    }
  });

  it("hint says what to send", () => {
    expect(DATE_INPUT_HINT).toMatch(/YYYY-MM-DD/);
    expect(DATE_INPUT_HINT).toMatch(/Z or an offset/);
  });
});

describe("parseDateInput is independent of the server's time zone", () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  function under(tz: string): (string | null)[] {
    process.env.TZ = tz;
    return ACCEPTED.map(([input]) => parseDateInput(input));
  }

  it("gives the same result under two zones", () => {
    const copenhagen = under("Europe/Copenhagen");
    // Sanity: the zone switch is live, so a zoneless string would differ.
    const zonelessCph = new Date("2026-11-16T09:00:00").toISOString();
    const kiritimati = under("Pacific/Kiritimati");
    const zonelessKir = new Date("2026-11-16T09:00:00").toISOString();
    expect(zonelessCph).not.toBe(zonelessKir);

    expect(kiritimati).toEqual(copenhagen);
    expect(copenhagen).toEqual(ACCEPTED.map(([, stored]) => stored));
  });
});

describe("parseDayInput (a day-precision property)", () => {
  it.each(["2026-11-16", "2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31"])("keeps %s as sent", (input) => {
    expect(parseDayInput(input)).toBe(input);
  });

  it.each([
    "2026-11-16T00:00:00.000Z",
    "2026-11-16T00:00:00+01:00",
    "2026-11-16T09:00Z",
    "2026-02-30",
    "2026-02-29",
    "1900-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-11-00",
    "2026-11-6",
    " 2026-11-16",
    "2026-11",
    "20261116",
    "+002026-11-16",
  ])("refuses %s", (input) => {
    expect(parseDayInput(input)).toBeNull();
  });

  it.each([20261116, null, undefined, true, {}])("refuses the non-string %s", (input) => {
    expect(parseDayInput(input)).toBeNull();
  });

  it("names the form to send", () => {
    expect(DAY_INPUT_HINT).toMatch(/send YYYY-MM-DD/);
  });
});

describe("config.precision", () => {
  it("is valid on a date property, single or multi", () => {
    expect(validatePropertyConfig("date", false, { precision: "day" })).toEqual([]);
    expect(validatePropertyConfig("date", true, { precision: "instant" })).toEqual([]);
  });
  it("is refused on other datatypes and for unknown values", () => {
    expect(validatePropertyConfig("text", false, { precision: "day" })).toEqual(["config.precision is not valid for a text property"]);
    expect(validatePropertyConfig("date", false, { precision: "hour" as never })).toEqual([
      "config.precision must be one of: day, instant",
    ]);
  });
});
