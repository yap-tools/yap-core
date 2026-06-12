/** Minimal column formatter for list output (use --json for the raw body). */
export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return "(none)";
  const cell = (row: Record<string, unknown>, col: string): string => {
    const value = col.split(".").reduce<unknown>((acc, part) => {
      return acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined;
    }, row);
    if (value === undefined || value === null || value === "") return "-";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };
  const header = columns.map((c) => c.toUpperCase());
  const body = rows.map((row) => columns.map((col) => cell(row, col)));
  const widths = columns.map((_, i) => Math.max(header[i]!.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}
