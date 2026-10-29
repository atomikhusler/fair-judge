import React, { createContext, useContext, useEffect, useState, useMemo } from 'react';
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
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({
  children,
  defaultTheme,
  storageKey = 'fair-judge-theme',
  attribute = 'class',
  enableSystem = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return defaultTheme || 'dark';
    try {
      const stored = localStorage.getItem(storageKey) as Theme | null;
      if (stored === 'dark' || stored === 'light') {
        return stored;
      }
    } catch {
      // Fallback if localStorage is inaccessible
    }
    // On initial boot, before any manual user override is found in localStorage:
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return prefersDark ? 'dark' : 'light';
  });

  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(getSystemTheme);

  // Monitor system theme changes
  useEffect(() => {
    if (!enableSystem || typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (e: MediaQueryListEvent) => {
      const currentSysTheme = e.matches ? 'dark' : 'light';
      setSystemTheme(currentSysTheme);
      try {
        const stored = localStorage.getItem(storageKey);
        if (!stored) {
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

  // Apply to DOM (both html and body + meta theme-color)
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const body = document.body;

    root.classList.remove('light', 'dark');
    root.classList.add(resolvedTheme);
    root.setAttribute('data-theme', resolvedTheme);
    root.style.colorScheme = resolvedTheme;

    if (body) {
      body.classList.remove('light', 'dark');
      body.classList.add(resolvedTheme);
      body.setAttribute('data-theme', resolvedTheme);
    }

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', resolvedTheme === 'dark' ? '#000000' : '#fafaf9');
    }
  }, [resolvedTheme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    try {
      localStorage.setItem(storageKey, newTheme);
    } catch {
      // Ignore localStorage errors in private browsing
    }
  };

  const contextValue = useMemo<ThemeContextType>(() => ({
    theme,
    setTheme,
    resolvedTheme,
    systemTheme,
    themes: ['dark', 'light', 'system'],
  }), [theme, resolvedTheme, systemTheme]);

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
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

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className={
        className ||
        "p-2 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-all shadow-sm active:scale-95 cursor-pointer"
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
