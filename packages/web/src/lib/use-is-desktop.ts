import { useSyncExternalStore } from "react";

/** Mirror Tailwind's `sm:` breakpoint by reading `--breakpoint-sm` at module load — keeps the media query in lockstep with `sm:` utility classes. Module-scoped so every consumer shares the same `MediaQueryList` and listener set. */
const smMediaQuery: MediaQueryList | null = (() => {
  if (typeof window === "undefined") return null;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--breakpoint-sm")
    .trim();
  return window.matchMedia(`(min-width: ${raw || "40rem"})`);
})();

const subscribe = (onChange: () => void) => {
  if (!smMediaQuery) return () => {};
  smMediaQuery.addEventListener("change", onChange);
  return () => smMediaQuery.removeEventListener("change", onChange);
};

const getSnapshot = () => smMediaQuery?.matches ?? false;
const getServerSnapshot = () => false;

/** `true` when the viewport is at least Tailwind's `sm` breakpoint wide. SSR-safe (defaults to `false`). */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
