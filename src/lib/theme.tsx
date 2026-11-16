import React, { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { Sun, Moon } from 'lucide-react';

type Theme = 'dark' | 'light' | 'system';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  attribute?: 'class' | 'data-theme';
  enableSystem?: boolean;
}

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolvedTheme: 'dark' | 'light';
  systemTheme: 'dark' | 'light';
  themes: Theme[];
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function applyThemeClassToDom(resolved: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const body = document.body;

  if (resolved === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  root.classList.remove('light');
  root.removeAttribute('data-theme');
  root.style.colorScheme = resolved;
  root.style.removeProperty('background-color');

  if (body) {
    body.classList.remove('dark', 'light');
    body.removeAttribute('data-theme');
  }

  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    metaTheme.setAttribute('content', resolved === 'dark' ? '#000000' : '#fafaf9');
  }
}

export function ThemeProvider({
  children,
  defaultTheme,
  storageKey = 'theme',
  enableSystem = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return defaultTheme || 'dark';
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored === 'dark' || stored === 'light') {
        return stored;
      }
      const legacy = localStorage.getItem('fair-judge-theme');
      if (legacy === 'dark' || legacy === 'light') {
        localStorage.setItem(storageKey, legacy);
        return legacy;
      }
    } catch {
      // Fallback if localStorage is inaccessible
    }
    if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) {
      return 'dark';
    }
    return getSystemTheme();
  });

  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(getSystemTheme);

  // Monitor system theme changes ONLY when no manual localStorage override is saved
  useEffect(() => {
    if (!enableSystem || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e: MediaQueryListEvent) => {
      const currentSysTheme = e.matches ? 'dark' : 'light';
      setSystemTheme(currentSysTheme);
      try {
        const stored = localStorage.getItem(storageKey);
        if (stored !== 'dark' && stored !== 'light') {
          applyThemeClassToDom(currentSysTheme);
          setThemeState(currentSysTheme);
        }
      } catch {}
    };
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [enableSystem, storageKey]);

  // Compute resolved theme
  const resolvedTheme: 'dark' | 'light' = useMemo(() => {
    if (theme === 'system') return systemTheme;
    return theme === 'light' ? 'light' : 'dark';
  }, [theme, systemTheme]);

  // Keep DOM strictly synced to resolvedTheme
  useEffect(() => {
    applyThemeClassToDom(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback(
    (newTheme: Theme) => {
      const nextResolved: 'dark' | 'light' =
        newTheme === 'system' ? getSystemTheme() : newTheme === 'light' ? 'light' : 'dark';
      applyThemeClassToDom(nextResolved);
      setThemeState(newTheme);
      try {
        localStorage.setItem(storageKey, newTheme);
        localStorage.removeItem('fair-judge-theme');
      } catch {
        // Ignore localStorage errors in private browsing
      }
    },
    [storageKey]
  );

  const contextValue = useMemo<ThemeContextType>(
    () => ({
      theme,
      setTheme,
      resolvedTheme,
      systemTheme,
      themes: ['dark', 'light', 'system'],
    }),
    [theme, setTheme, resolvedTheme, systemTheme]
  );

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export function ThemeToggleButton({ className }: { className?: string }) {
  const { setTheme, resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const handleToggle = () => {
    const currentlyDark = document.documentElement.classList.contains('dark');
    if (currentlyDark) {
      document.documentElement.classList.remove('dark');
      try {
        localStorage.setItem('theme', 'light');
      } catch {}
      setTheme('light');
    } else {
      document.documentElement.classList.add('dark');
      try {
        localStorage.setItem('theme', 'dark');
      } catch {}
      setTheme('dark');
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={
        className ||
        "w-11 h-11 flex items-center justify-center rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors shadow-sm active:scale-95 motion-reduce:transition-none cursor-pointer"
      }
      title={`Switch to ${isDark ? 'Light' : 'Dark'} Mode`}
      aria-label="Toggle Theme"
    >
      {isDark ? (
        <Sun className="w-4 h-4 text-amber-400 stroke-[2.5]" />
      ) : (
        <Moon className="w-4 h-4 text-indigo-500 stroke-[2.5]" />
      )}
    </button>
  );
}
