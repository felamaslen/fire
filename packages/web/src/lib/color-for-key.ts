// Stable hue-based colour hash. Used by charts, allocation bars, and anywhere
// we render multiple series that need a consistent colour keyed to an
// investment's ticker / name. Deterministic in the input: same key always
// yields the same HSL triple, regardless of list ordering or cardinality.
//
// The intent is to match what `color-hash` on npm produces in spirit (stable,
// readable on dark or light backgrounds) without adding a dependency for a
// dozen lines of code.

const SATURATION = 0.65;
const LIGHTNESS = 0.45;

function hash32(input: string): number {
  // FNV-1a 32-bit — small, fast, good enough avalanche for short strings.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable CSS colour for `key`. Returns an `hsl(...)` string. */
export function colorForKey(key: string): string {
  const h = hash32(key);
  // Spread hue across the wheel, scaled through a low-period multiplier so
  // visually-adjacent tickers (e.g. "AAPL" vs "AAPZ") still land in different
  // bands.
  const hue = (h * 137) % 360;
  return `hsl(${hue.toFixed(0)}, ${(SATURATION * 100).toFixed(0)}%, ${(LIGHTNESS * 100).toFixed(0)}%)`;
}
