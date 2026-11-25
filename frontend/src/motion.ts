// Single source of truth for Fleet workbench motion values (Emil Kowalski Motion Contract v2.0).
// Matches CSS tokens in theme.css (--dur-press, --dur-reveal, --dur-swap, --dur-enter, --dur-sheet, --ease-house).
export const ease = [0.23, 1, 0.32, 1] as [number, number, number, number];
export const easeCss = "cubic-bezier(0.23, 1, 0.32, 1)";
export const dur = { press: 0.15, reveal: 0.18, swap: 0.2, enter: 0.22, sheet: 0.22 };

/** Active press feedback: scale(0.97) 150ms. */
export const press = { duration: dur.press, ease };

/** Interruptible spring indicator for active tabs, switches, and inbox row markers. */
export const glide = { type: "spring" as const, stiffness: 450, damping: 35, mass: 0.7 };

/** Subtle hover/popover reveal (180ms). */
export const reveal = { duration: dur.reveal, ease };

/** Drawer, inspector, and dialog entrance/exit (220ms). */
export const enter = { duration: dur.enter, ease };

/** Keyboard-initiated and 100+/day actions execute immediately. */
export const instant = { duration: 0 };

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function animatePanelEnter(el: HTMLElement | null): void {
  if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return;
  el.animate(
    [
      { opacity: 0, transform: "translateY(6px) scale(0.98)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    { duration: Math.round(dur.enter * 1000), easing: easeCss, fill: "both" },
  );
}
