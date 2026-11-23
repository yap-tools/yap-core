# Dates

A `date` property holds one instant, stored and returned as a UTC ISO-8601
string with milliseconds: `2026-11-16T08:00:00.000Z`. Because every stored
date has that one shape, dates sort, compare and range-filter correctly as
text on both SQLite and Postgres.

## What a date property accepts

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

**Recommendation:** for something that is a day (a due date, a birthday), send
`YYYY-MM-DD`. For a moment (a meeting start, when a message arrived), send a
timestamp with its zone.

Fractions beyond milliseconds are truncated. The year must have four digits
(0000–9999), before and after the offset is applied. The parser works only
from the fields written in the value, never from the server's own time zone,
so the same input stores the same instant on every host. Implementation:
`src/core/dates.ts`.

## What is refused

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
