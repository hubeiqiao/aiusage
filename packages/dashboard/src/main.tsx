import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { EmbedApp } from './embed/embed-app';
import './styles.css';

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
window.scrollTo(0, 0);

// Prevent native iOS Safari pinch zoom at document level.
// iOS ignores user-scalable=no since iOS 10, so we must intercept touch events.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => {
  // Block native zoom when 2+ fingers detected — our custom handler in
  // usePinchTextZoom will handle the zoom via CSS zoom property
  if (e.touches.length >= 2) e.preventDefault();
}, { passive: false });

const isEmbed = window.location.pathname.startsWith('/embed') && !window.location.pathname.startsWith('/embed/docs');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isEmbed ? <EmbedApp /> : <App />}
  </React.StrictMode>,
);
