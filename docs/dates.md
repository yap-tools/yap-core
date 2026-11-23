# Dates

A `date` property holds one of two things, chosen per property by
`config.precision`:

- **an instant** (the default, `precision` left out or `"instant"`): one
  moment, stored and returned as a UTC ISO-8601 string with milliseconds,
  `2026-11-16T08:00:00.000Z`;
- **a day** (`"precision": "day"`): a calendar day, stored and returned
  exactly as sent, `2026-11-16`, with no time and no zone.

Every stored value on a property has the one fixed-width shape its precision
gives it, so dates sort, compare and range-filter correctly as text on both
SQLite and Postgres.

Use a day for things that are a day wherever you are: a due date, a
birthday, a holiday. Use an instant for things that happen at a moment: a
meeting start, when a message arrived. An instant can only say "the 16th" as
some moment on it, and which date that moment falls on depends on the reader's
time zone; a day cannot be shifted that way.

```json
{"name": "due", "datatype": "date", "config": {"precision": "day"}}
```

## What an instant property accepts

Exactly two forms, on every path a date comes in: item create and update over
REST and MCP, a service run's writer, and filter values on a date property
(`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, and the multi-field set
operators). `contains` is the exception: it is a substring match on the stored
UTC text, not a date, so `{"op": "contains", "value": "2026-11"}` finds every
date stored in November 2026 (UTC) and its value is not parsed.

| Send | Example | Stored as |
|---|---|---|
| A bare day, `YYYY-MM-DD` | `2026-11-16` | midnight UTC of that day: `2026-11-16T00:00:00.000Z` |
| A timestamp with its zone: `YYYY-MM-DDTHH:MM`, optional `:SS` and `.fraction`, then `Z` or `±HH:MM` | `2026-11-16T09:00:00+01:00`, `2026-11-16T08:00Z`, `2026-11-16T08:00:00.250Z` | that instant in UTC: `2026-11-16T08:00:00.000Z`, `2026-11-16T08:00:00.000Z`, `2026-11-16T08:00:00.250Z` |

For a moment, send a timestamp with its zone. A bare day sent to an instant
property means midnight UTC of that day; if the value really is a day, make
the property a day property instead (see below).

Fractions beyond milliseconds are truncated. The year must have four digits
(0000–9999), before and after the offset is applied. The parser works only
from the fields written in the value, never from the server's own time zone,
so the same input stores the same instant on every host. Implementation:
`src/core/dates.ts`.

## What an instant property refuses

Anything else is a validation error (`invalid_request`, HTTP 400) that names
the property, shows the value and says what to send:

```
property "due" expects a date, got "2026-11-16T09:00:00": send YYYY-MM-DD for a day, or a timestamp with Z or an offset (e.g. 2026-11-16T09:00:00+01:00)
```

A filter value is refused the same way, as `filter on "due" expects a date, …`.

Refused inputs include:

- **A timestamp with no zone**: `2026-11-16T09:00:00`, `2026-11-16T09:00`.
  These used to be read in the server's local time, so the same input stored a
  different instant depending on how the host's clock was set.
- **Other strings `Date.parse` happens to take**: `Nov 16, 2026`,
  `2026/11/16`, RFC 2822 (`Mon, 16 Nov 2026 09:00:00 GMT`), a year alone
  (`2026`), a year and month (`2026-11`), a space instead of `T`, lower-case
  `t` or `z`, an offset without a colon (`+0100`) or without minutes (`+01`),
  expanded years (`+002026-11-16`), ISO week and ordinal dates, and leading or
  trailing whitespace.
- **Impossible dates and times in an accepted form**: `2026-02-30`,
  `2026-02-29`, `2026-13-01`, `T24:00`, minute or second 60, an offset of
  `+24:00` or more. These used to be rolled over silently (`2026-02-30`
  became 2 March).
- **Anything that is not a string**: numbers (epoch milliseconds), booleans,
  objects.

## What a day property accepts

Only a bare day, `YYYY-MM-DD`, that is a real calendar date. It is stored and
read back exactly as sent, on writes and as filter values alike:

| Send | Stored and read back as |
|---|---|
| `2026-11-16` | `2026-11-16` |
| `2028-02-29` | `2028-02-29` |

Everything else is refused, with the same `invalid_request` (HTTP 400):

```
property "due" expects a day, got "2026-11-16T00:00:00+01:00": send YYYY-MM-DD (e.g. 2026-11-16), with no time or zone
```

That includes every timestamp, even one at midnight UTC: taking its date
part would mean picking a time zone, and `2026-11-16T00:00:00+01:00` is the
15th in UTC and the 16th at UTC+1. The caller knows which day it means
and sends that. Impossible days (`2026-02-30`, `2026-13-01`) and every form
an instant property refuses are refused too.

Filters work on the day: `eq`, `neq` and `in` (and the set operators on a
multi property) match the day exactly; `gt`, `gte`, `lt` and `lte` compare
days (`{"op": "lt", "value": "2026-11-16"}` finds everything up to and
including the 15th); sort orders by day. `contains` is still a substring
match on the stored text, so `"2026-11"` finds every day in November 2026.

## Switching a property between instant and day

`precision` can be set on an existing `date` property with an
`update_property` (REST `PATCH /v1/item-types/:id/properties/:propId`). The
datatype stays `date`; the values already stored are rewritten in the same
transaction as the config change, so the property never holds a mix.

- **Instant to day.** A value at exactly midnight UTC
  (`2026-11-16T00:00:00.000Z`) becomes its day (`2026-11-16`). Any other
  value is ambiguous (`2026-11-15T23:00:00.000Z` may be midnight on the 16th
  at UTC+1, or an evening on the 15th), and Yap does not guess: the
  switch is refused, nothing is changed, and the error names up to five
  items holding such a value. Set each of those to the day it means (send
  `YYYY-MM-DD`, which stores midnight UTC while the property is still an
  instant) or clear it, then switch again.
- **Day to instant.** Each day becomes midnight UTC of that day
  (`2026-11-16` → `2026-11-16T00:00:00.000Z`).

An item write that was validated under the old precision while a switch
committed is refused with `conflict` (HTTP 409) instead of storing a value in
the old form; sending it again validates it under the new precision. On
Postgres the switch and item writes to the property take row locks on the
property, so they run one after the other; SQLite runs each transaction
without interleaving.

A query is not locked the same way: one that reads the property while a
switch commits may compare its filter value in the old form against values
already converted, and miss them. The next query sees the new precision.

`config` is replaced whole by an update, as for every other constraint: a
config patch that leaves `precision` out makes the property an instant
property again, and converts its days. Send the full config, `precision`
included, when changing another key. A patch without `config` (a rename, say)
leaves the precision and the values alone.

## Stored data and backups

Nothing already stored changes, and there is no migration. Values were always
normalised to the UTC form on the way in, so a stored value is itself an
accepted input: reading an item and writing its dates back, or filtering on a
value read from an item, keeps working. A backup holds stored values, so a
backup taken before this change restores unchanged.

One exception: earlier versions also took years outside 0000–9999
(`+010000-01-01`) and stored them in the expanded form
(`+010000-01-01T00:00:00.000Z`). Such a value still reads back, but it is no
longer accepted as input, so writing it back or filtering on it with anything
but `contains` is refused.

Day precision needs no migration either: `precision` is a key in the
property's config, so every existing `date` property keeps holding instants,
and behaves exactly as before, until its owner sets `"precision": "day"` on
it. A backup carries the config and the stored values as they are, so a day
property restores as a day property.

## Upgrading

This is a breaking change for callers that sent anything but the two forms
above. After upgrading, these writes and filters fail with the error shown
above instead of storing a value:

- zoneless timestamps (`2026-11-16T09:00:00`, `2026-11-16T09:00`);
- non-ISO strings (`Nov 16, 2026`, `2026/11/16`, RFC 2822 dates, `2026`,
  `2026-11`);
- impossible dates that were rolled over (`2026-02-30`).

What to send instead: `YYYY-MM-DD` for a day; for a moment, the timestamp with
`Z` or its offset (`2026-11-16T09:00:00+01:00`). A caller that formats dates
with JavaScript's `toISOString()` already sends an accepted form. There is no
setting to turn the old, looser parsing back on.

Before upgrading an instance, check the drivers installed in it and any
scripts or apps that write items: anything that builds date strings by hand,
or passes through dates from another system (a calendar feed, a mail header),
must send one of the two forms.
