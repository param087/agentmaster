import type { GitStatusResponse, HarnessInfo, NotifyPrefs, Session, StatusEvent } from './types';

/** A non-2xx response from the server, carrying its status and `{error}` message. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Preset {
  id: string;
  name: string;
  harnessId: string;
  cwd: string;
  prompt: string | null;
  createdAt: number;
}

export interface DirEntry {
  name: string;
  path: string;
}

export interface LsResult {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
}

/** Best-effort extraction of the server's `{error}` body; falls back to the status text. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const { error } = body as { error: unknown };
      if (typeof error === 'string' && error.length > 0) return error;
    }
  } catch {
    // Non-JSON error bodies (proxy failures, HTML pages) are not worth reporting verbatim.
  }
  return res.statusText || `Request failed with status ${res.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (cause) {
    // A dead server must not look like an empty result set.
    throw new ApiError(cause instanceof Error ? cause.message : 'Network request failed', 0);
  }

  if (!res.ok) throw new ApiError(await errorMessage(res), res.status);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  async harnesses(): Promise<HarnessInfo[]> {
    const { harnesses } = await request<{ harnesses: HarnessInfo[] }>('/harnesses');
    return harnesses;
  },

  async sessions(): Promise<Session[]> {
    const { sessions } = await request<{ sessions: Session[] }>('/sessions');
    return sessions;
  },

  async presets(): Promise<Preset[]> {
    const { presets } = await request<{ presets: Preset[] }>('/presets');
    return presets;
  },

  async savePreset(input: { name: string; harnessId: string; cwd: string; prompt?: string }): Promise<Preset> {
    const { preset } = await request<{ preset: Preset }>('/presets', jsonPost(input));
    return preset;
  },

  deletePreset(id: string): Promise<void> {
    return request<void>(`/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  async launchPreset(id: string): Promise<Session> {
    const { session } = await request<{ session: Session }>(
      `/presets/${encodeURIComponent(id)}/launch`,
      { method: 'POST' },
    );
    return session;
  },

  async createSession(input: {
    harnessId: string;
    cwd: string;
    title?: string;
    initialPrompt?: string;
  }): Promise<Session> {
    const { session } = await request<{ session: Session }>('/sessions', jsonPost(input));
    return session;
  },

  gitStatus(id: string): Promise<GitStatusResponse> {
    return request<GitStatusResponse>(`/sessions/${encodeURIComponent(id)}/git`);
  },

  gitDiff(id: string, path: string): Promise<{ diff: string; truncated: boolean }> {
    return request(`/sessions/${encodeURIComponent(id)}/git/diff?path=${encodeURIComponent(path)}`);
  },

  async notifyPrefs(): Promise<NotifyPrefs> {
    const { prefs } = await request<{ prefs: NotifyPrefs }>('/notify-prefs');
    return prefs;
  },

  async saveNotifyPrefs(prefs: NotifyPrefs): Promise<NotifyPrefs> {
    const { prefs: saved } = await request<{ prefs: NotifyPrefs }>('/notify-prefs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(prefs),
    });
    return saved;
  },

  async sessionEvents(id: string): Promise<StatusEvent[]> {
    const { events } = await request<{ events: StatusEvent[] }>(
      `/sessions/${encodeURIComponent(id)}/events`,
    );
    return events;
  },

  /** Renames and/or pins a session. */
  async updateSession(
    id: string,
    patch: { title?: string; pinned?: boolean; muted?: boolean },
  ): Promise<Session> {
    const { session } = await request<{ session: Session }>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    return session;
  },

  /** Kills the process but keeps the session listed so its output stays readable. */
  killSession(id: string): Promise<void> {
    return request<void>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  removeSession(id: string): Promise<void> {
    return request<void>(`/sessions/${encodeURIComponent(id)}/remove`, { method: 'POST' });
  },

  /** Re-spawns a stopped session in place, keeping its id and scrollback slot. */
  restartSession(id: string, force = false): Promise<{ session: Session }> {
    const query = force ? '?force=1' : '';
    return request<{ session: Session }>(`/sessions/${encodeURIComponent(id)}/restart${query}`, {
      method: 'POST',
    });
  },

  /** Forgets every stopped session, leaving running ones alone. */
  removeFinished(): Promise<{ removed: number }> {
    return request<{ removed: number }>('/sessions/finished/remove', { method: 'POST' });
  },

  sendInput(id: string, keys: string): Promise<void> {
    return request<void>(`/sessions/${encodeURIComponent(id)}/input`, jsonPost({ keys }));
  },

  ls(path?: string): Promise<LsResult> {
    const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`;
    return request<LsResult>(`/fs/ls${query}`);
  },

  /** Shows or hides a harness in the new-session picker. */
  setHarnessEnabled(id: string, enabled: boolean): Promise<{ harness: HarnessInfo }> {
    return request<{ harness: HarnessInfo }>(
      `/harnesses/${encodeURIComponent(id)}/enabled`,
      jsonPost({ enabled }),
    );
  },

  /** Creates one directory inside `parent`. `name` must be a single segment. */
  mkdir(parent: string, name: string): Promise<{ path: string }> {
    return request<{ path: string }>('/fs/mkdir', jsonPost({ parent, name }));
  },
};
