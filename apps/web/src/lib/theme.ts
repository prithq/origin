/**
 * Theme handling.
 *
 * Dark is the default. The choice is persisted so a demo does not flip themes
 * on reload, and the initial value is applied before first paint to avoid a
 * flash of the wrong theme.
 */

import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "origin-theme";

export function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage may be unavailable */
  }
  return "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

export function useTheme(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return {
    theme,
    setTheme: setThemeState,
    toggle: () => setThemeState((t) => (t === "dark" ? "light" : "dark")),
  };
}
