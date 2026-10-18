import { useState } from "react";

// The reader's color choice: follow the operating system, or force light or dark.
type Theme = "system" | "light" | "dark";

// Same key the inline script in index.html reads, so the saved choice applies before the first paint.
const STORAGE_KEY = "cc-trajectory:theme";

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "◐ system", light: "☀ light", dark: "☾ dark" };

// Reads the saved choice. Storage can be blocked (private windows, strict settings), which means "system".
function loadTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Unreadable storage: fall back to the system theme.
  }
  return "system";
}

// Puts a choice into effect and remembers it. styles.css keys the dark colors off data-theme on <html>;
// no attribute means follow the system.
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Unwritable storage: the choice still holds until the page reloads.
  }
}

// Header button that cycles System → Light → Dark and shows the current choice.
export function ThemeToggle() {
  const [theme, setTheme] = useState(loadTheme);

  function cycle() {
    const next = NEXT[theme];
    applyTheme(next);
    setTheme(next);
  }

  return (
    <button type="button" className="theme-toggle" onClick={cycle} title={`Theme: ${theme}. Click for ${NEXT[theme]}.`}>
      {LABEL[theme]}
    </button>
  );
}
