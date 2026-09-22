/*
 * agentmaster service worker.
 *
 * Its entire job is Web Push. On a phone the tab will not be alive when a
 * session blocks, and `new Notification()` from a dead page reaches nobody —
 * this file is the only way an alert arrives when the app is closed. On iOS it
 * only runs at all once the site has been added to the Home Screen.
 *
 * Deliberately NOT a caching service worker. There is no offline story worth
 * having: the app is a live mirror of PTYs on a server it must be talking to,
 * so a cached shell would render an empty, permanently "disconnected" UI. Worse,
 * a cached bundle outliving a server upgrade gives you an old client speaking to
 * a new API — a silent, confusing failure that is much harder to diagnose than
 * "the server is down". Every request goes to the network, always.
 *
 * Plain JS, served verbatim from /public. It is not bundled, so no imports and
 * no TypeScript syntax.
 */

// Take over immediately rather than waiting for every tab to close. A stale
// worker missing a push fix is exactly the bug this file exists to prevent.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Payload the server sends; see server/src/push/sender.ts. */
const FALLBACK = {
  id: 'agentmaster',
  title: 'agentmaster',
  body: 'A session needs you.',
};

function readPayload(event) {
  // Some push services deliver a payload-less "wake up" push, and Chrome will
  // show its own scary "This site has been updated in the background" if we
  // fail to display anything. Always end up with something showable.
  if (!event.data) return FALLBACK;
  try {
    const data = event.data.json();
    if (!data || typeof data !== 'object') return FALLBACK;
    const actions = Array.isArray(data.actions)
      ? data.actions
          .filter((a) => a && typeof a.label === 'string' && typeof a.keys === 'string')
          .slice(0, 2)
      : [];
    return {
      id: typeof data.id === 'string' && data.id ? data.id : FALLBACK.id,
      title: typeof data.title === 'string' && data.title ? data.title : FALLBACK.title,
      body: typeof data.body === 'string' ? data.body : FALLBACK.body,
      actions: actions,
    };
  } catch {
    return FALLBACK;
  }
}

self.addEventListener('push', (event) => {
  const payload = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Coalesce by session: a session that keeps re-entering "waiting" should
      // replace its own alert, not stack twenty of them in Notification Centre.
      tag: payload.id,
      // Buttons answer a prompt without opening the app. The keys ride along
      // in `data`, indexed by action id, because `actions` only carries labels.
      actions: (payload.actions || []).map((a, i) => ({ action: String(i), title: a.label })),
      data: { id: payload.id, keys: (payload.actions || []).map((a) => a.keys) },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const id = data.id || '';

  // A button: type its keys into the session and stay out of the way. Falls
  // through to opening the app if delivery fails, so the prompt is not lost.
  if (event.action !== '' && Array.isArray(data.keys)) {
    const keys = data.keys[Number(event.action)];
    if (typeof keys === 'string' && id) {
      event.waitUntil(
        fetch('/api/sessions/' + encodeURIComponent(id) + '/input', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ keys: keys }),
        }).then((res) => {
          if (!res.ok) return self.clients.openWindow('/?session=' + encodeURIComponent(id));
          return undefined;
        }, () => self.clients.openWindow('/?session=' + encodeURIComponent(id))),
      );
      return;
    }
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Prefer an already-open window: opening a second copy of a live terminal
      // dashboard is never what the user wanted.
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'agentmaster:select', id: id });
          return client.focus();
        }
      }
      return self.clients.openWindow('/?session=' + encodeURIComponent(id));
    }),
  );
});
