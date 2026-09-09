import { EventEmitter } from 'node:events';

import type { ServerEvent } from './status/types.js';

const EVENT = 'event';

/**
 * Process-wide fan-out point for {@link ServerEvent}s.
 *
 * The WebSocket layer subscribes here rather than importing the session
 * manager, which keeps transport and lifecycle independent of one another.
 *
 * The listener count tracks connected browser tabs, so the default limit of 10
 * would produce spurious MaxListenersExceededWarning noise.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitServerEvent(e: ServerEvent): void {
  bus.emit(EVENT, e);
}

/** Subscribes to server events. Returns an unsubscribe function. */
export function onServerEvent(fn: (e: ServerEvent) => void): () => void {
  bus.on(EVENT, fn);
  return () => {
    bus.off(EVENT, fn);
  };
}
