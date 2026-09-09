import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Registers the push service worker.
 *
 * Guarded on `isSecureContext` as well as feature detection: over plain HTTP on
 * the LAN (`http://192.168.x.x:5273`) `navigator.serviceWorker` exists but
 * `register()` rejects, and an unhandled rejection on boot is a worse outcome
 * than quietly having no push. localhost and the Tailscale HTTPS hostname are
 * both secure, which is where push actually works.
 */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
    console.warn('[agentmaster] service worker registration failed', error);
  });
}
