/**
 * Format a tabular snapshot as a single newline-separated string. Each column is right-padded (with a trailing space separator) to the width of its widest cell (including the header). Keeps inline snapshots readable and diff-friendly.
 *
 * ```ts
 * expect(
 *   formatTable(
 *     ["GROSS", "NET"],
 *     [[8_000_000, 5_221_395]],
 *   ),
 * ).toMatchInlineSnapshot();
 * ```
 */
export function formatTable(
  headers: string[],
  rows: readonly (readonly unknown[])[],
): string {
  const stringRows = rows.map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...stringRows.map((row) => row[i]?.length ?? 0)),
  );
  return (
    "\n" +
    [headers, ...stringRows]
      .map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(" "))
      .join("\n")
  );
}
