import { useEffect, type RefObject } from "react";

// Scrolls the element into view and flashes it when the outline asked to jump here, then reports back.
// Runs on mount too, so an item revealed by expanding a folded group still gets scrolled to.
export function useJumpTarget(ref: RefObject<HTMLElement | null>, focused: boolean | undefined, onFocused?: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!focused || !el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the highlight animation when the same item is picked again
    el.classList.add("flash");
    onFocused?.();
  }, [ref, focused, onFocused]);
}
