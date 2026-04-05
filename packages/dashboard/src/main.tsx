import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './app';
import { EmbedApp } from './embed/embed-app';
import './styles.css';

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}
window.scrollTo(0, 0);

// Prevent native iOS Safari pinch zoom — gesturestart fires before touchmove.
// The touchmove prevention is handled by usePinchTextZoom at document level.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());

const isEmbed = window.location.pathname.startsWith('/embed') && !window.location.pathname.startsWith('/embed/docs');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isEmbed ? <EmbedApp /> : <App />}
  </React.StrictMode>,
);
