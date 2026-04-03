import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void) {
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => obs.disconnect();
}

function getSnapshot() {
  return document.documentElement.classList.contains('dark');
}

export function useIsDark() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
