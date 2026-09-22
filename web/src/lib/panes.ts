export type PaneLayout = 1 | 2 | 4;
export const PANE_LAYOUTS: readonly PaneLayout[] = [1, 2, 4];

export interface PaneState {
  layout: PaneLayout;
  /** Session shown in each pane; `null` is an empty pane. Length === layout. */
  panes: (string | null)[];
  focused: number;
}

export function initialPanes(layout: PaneLayout, selectedId: string | null): PaneState {
  const panes: (string | null)[] = Array.from({ length: layout }, () => null);
  panes[0] = selectedId;
  return { layout, panes, focused: 0 };
}

/** Grows or shrinks the grid, keeping existing panes and the focused one visible. */
export function setLayout(state: PaneState, layout: PaneLayout): PaneState {
  const focusedId = state.panes[state.focused] ?? null;
  let panes = state.panes.slice(0, layout);
  while (panes.length < layout) panes.push(null);
  let focused = Math.min(state.focused, layout - 1);
  // Shrinking must not hide what the user is looking at.
  if (focusedId !== null && !panes.includes(focusedId)) {
    panes = [focusedId, ...panes.slice(0, layout - 1)];
    focused = 0;
  }
  return { layout, panes, focused };
}

/**
 * Shows `id` in the focused pane. A session already on screen elsewhere is
 * focused there instead — the same PTY twice side by side is never useful.
 */
export function showSession(state: PaneState, id: string): PaneState {
  const existing = state.panes.indexOf(id);
  if (existing !== -1) return { ...state, focused: existing };
  const panes = [...state.panes];
  panes[state.focused] = id;
  return { ...state, panes };
}

export function focusPane(state: PaneState, index: number): PaneState {
  if (index < 0 || index >= state.layout) return state;
  return { ...state, focused: index };
}

/** Drops sessions that no longer exist, leaving their panes empty. */
export function pruneMissing(state: PaneState, liveIds: ReadonlySet<string>): PaneState {
  if (state.panes.every((id) => id === null || liveIds.has(id))) return state;
  return { ...state, panes: state.panes.map((id) => (id !== null && liveIds.has(id) ? id : null)) };
}
