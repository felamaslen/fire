import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

/** State of the quick net-worth wizard, kept in the URL so it survives a refresh.
 *
 * The wizard walks the rows of a snapshot net-worth entry one at a time. Rows
 * and currencies are positional: the snapshot entry's `values[]` (and each
 * row's `amounts[]`) define the order, so we only need to encode the entered
 * numbers, not any IDs. `s` is the snapshot entry id so we can detect a stale
 * URL when the underlying data has moved on.
 *
 * `null` means the user hasn't filled this slot in yet — at submit time, an
 * untouched slot keeps the snapshot's previous amount. */
export type WizardState = {
  s: string;
  i: number;
  v: (number | null)[][];
};

export function encodeWizardState(state: WizardState): string {
  return compressToEncodedURIComponent(JSON.stringify(state));
}

export function decodeWizardState(encoded: string): WizardState | null {
  const json = decompressFromEncodedURIComponent(encoded);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isWizardState(parsed)) return null;
  return parsed;
}

function isWizardState(x: unknown): x is WizardState {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.s !== "string") return false;
  if (typeof o.i !== "number" || !Number.isInteger(o.i) || o.i < 0)
    return false;
  if (!Array.isArray(o.v)) return false;
  for (const row of o.v) {
    if (!Array.isArray(row)) return false;
    for (const cell of row) {
      if (cell !== null && typeof cell !== "number") return false;
    }
  }
  return true;
}
