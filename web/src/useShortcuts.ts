import { useEffect, useLayoutEffect, useRef } from "react";

// macOS puts app shortcuts on ⌘; elsewhere they sit on Ctrl (on a Mac, Ctrl+K in a text field deletes to line end).
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

// Each handler may return false when it had nothing to do, which leaves the key to the browser.
export interface ShortcutHandlers {
  onEscape: () => boolean | void;
  onFocusPrompt: () => boolean | void;
  onStep: (delta: 1 | -1) => boolean | void;
  onToggleHelp: () => void;
}

// One keydown listener on window for the page's shortcuts. In a text field only Esc and ⌘K/Ctrl+K act,
// so j, k and ? can still be typed there.
export function useShortcuts(handlers: ShortcutHandlers) {
  // The listener is added once and always calls the latest handlers, which close over fresh state.
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // A component already used the key, or it is part of an IME composition (e.g. Esc cancelling Chinese input).
      if (e.defaultPrevented || e.isComposing) return;
      const h = latest.current;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let handled: boolean | void = false;

      if (key === "Escape") {
        handled = h.onEscape();
        // With nothing to close or stop, Esc leaves the text field so j/k work again.
        if (handled === false && isTextField(e.target)) e.target.blur();
      } else if (key === "k" && (IS_MAC ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        handled = h.onFocusPrompt();
      } else if (e.ctrlKey || e.metaKey || e.altKey || isTextField(e.target)) {
        return;
      } else if (key === "j" || key === "k") {
        handled = h.onStep(key === "j" ? 1 : -1);
      } else if (key === "?" && !e.repeat) {
        h.onToggleHelp();
        handled = true;
      }

      if (handled !== false) e.preventDefault();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function isTextField(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

// How long a step reached with j/k stays the base for the next press while its smooth scroll is still under way.
const SCROLL_GRACE_MS = 1000;

// j/k: moves from the step the reader is at (`current`, from the scroll spy) to the next or previous step in
// page order and asks `jump` to show it. A jumped-to step is centred, below the scroll spy's reading line, so
// while it is still on screen it stays the base; otherwise every press would land on or before the same step.
export function useStepNavigation(current: string | null, jump: (target: string) => void) {
  const last = useRef<{ target: string; at: number } | null>(null);
  return (delta: 1 | -1): boolean => {
    const steps = [...document.querySelectorAll<HTMLElement>(".runs [data-target]")];
    const prev = last.current;
    const prevEl = prev && steps.find((el) => el.dataset.target === prev.target);
    const base = prev && prevEl && (onScreen(prevEl) || Date.now() - prev.at < SCROLL_GRACE_MS) ? prev.target : current;
    const index = steps.findIndex((el) => el.dataset.target === base);
    const next = index === -1 ? (delta === 1 ? steps[0] : undefined) : steps[index + delta];
    const target = next?.dataset.target;
    if (!target) return false;
    last.current = { target, at: Date.now() };
    jump(target);
    return true;
  };
}

function onScreen(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.bottom > 0 && rect.top < window.innerHeight;
}
