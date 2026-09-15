'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'vaultide-theme';

const LABEL: Readonly<Record<Theme, string>> = { system: 'System', dark: 'Dark', light: 'Light' };

/** Each press moves one step: System, Dark, Light, and back to System. */
const NEXT: Readonly<Record<Theme, Theme>> = { system: 'dark', dark: 'light', light: 'system' };

/**
 * Light/dark control (blueprint 16.2: "Light and dark themes with identical
 * structure"). The document follows the system preference until the user
 * chooses; the choice is remembered locally, choosing System again forgets it,
 * and no third-party script is involved (17.3).
 *
 * The button shows the theme in effect, and its accessible name starts with
 * those same words before saying what a press does (16.6, WCAG 2.5.3).
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    if (theme !== 'system') root.classList.add(theme);

    if (theme === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const next = NEXT[theme];

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      className="rounded-[var(--radius-control)] border px-2 py-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      aria-label={`${LABEL[theme]} theme, switch to ${LABEL[next]}`}
      onClick={() => {
        setTheme(next);
      }}
    >
      {LABEL[theme]}
    </button>
  );
}
