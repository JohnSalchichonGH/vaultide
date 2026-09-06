'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'vaultide-theme';

/**
 * Light/dark control (blueprint 16.2: "Light and dark themes with identical
 * structure"). The document follows the system preference until the user
 * chooses; the choice is remembered locally, and no third-party script is
 * involved (17.3).
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

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      className="rounded-[var(--radius-control)] border px-2 py-1 text-[length:var(--text-meta)] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
      aria-label={`Switch to ${next} theme`}
      onClick={() => {
        setTheme(next);
      }}
    >
      {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'}
    </button>
  );
}
