export type ThemeMode = 'light' | 'dark' | 'system';

export function getStoredTheme(): ThemeMode {
  try { return (localStorage.getItem('aiusage-theme') as ThemeMode) ?? 'system'; }
  catch { return 'system'; }
}

let transitionTimer: ReturnType<typeof setTimeout> | undefined;

export function applyTheme(mode: ThemeMode, animate = true) {
  const isDark = mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;

  if (animate) {
    root.classList.add('theme-transition');
    clearTimeout(transitionTimer);
    transitionTimer = setTimeout(() => root.classList.remove('theme-transition'), 500);
  }

  root.classList.toggle('dark', isDark);
  try { localStorage.setItem('aiusage-theme', mode); } catch {}
}
