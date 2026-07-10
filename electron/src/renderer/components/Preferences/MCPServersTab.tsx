/**
 * MCPServersTab — list, edit, delete, and add MCP servers.
 *
 * Each server has: command (or url), args, env.
 * Changes to MCP servers trigger a restart prompt.
 */
import { useState, useCallback } from 'react';
import { DefinitionActions } from './DefinitionActions';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MCPServerEntry {
  id: string;
  command?: string;
  url?: string;
  args: string[];
  env: Record<string, string>;
}

export interface MCPServersTabProps {
  mcpServers: Record<string, Record<string, unknown>>;
  onChange: (servers: Record<string, Record<string, unknown>>) => void;
}

interface EditingServer {
  id: string;
  command: string;
  url: string;
  argsText: string; // space-separated or JSON array
  envText: string; // KEY=VALUE per line
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseServer(id: string, data: Record<string, unknown>): MCPServerEntry {
  const args = data.args;
  const env = data.env;
  return {
    id,
    command: data.command as string | undefined,
    url: data.url as string | undefined,
    args: Array.isArray(args) ? (args as string[]) : [],
    env: env && typeof env === 'object' ? (env as Record<string, string>) : {},
  };
}

function serverToDict(s: MCPServerEntry): Record<string, unknown> {
  const dict: Record<string, unknown> = {};
  if (s.command) dict.command = s.command;
  if (s.url) dict.url = s.url;
  if (s.args.length > 0) dict.args = s.args;
  if (Object.keys(s.env).length > 0) dict.env = s.env;
  return dict;
}

function parseArgsText(text: string): string[] {
  // Try JSON array first
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as string[];
    } catch {
      // fall through
    }
  }
  // Split by whitespace, respecting quoted strings
  return trimmed.split(/\s+/).filter(Boolean);
}

function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      env[key] = value;
    }
  }
  return env;
}

// ── Component ────────────────────────────────────────────────────────────────

export function MCPServersTab({ mcpServers, onChange }: MCPServersTabProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditingServer | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  // Parse servers dict into list
  const serverList = Object.entries(mcpServers).map(([id, data]) =>
    parseServer(id, data),
  );

  // ── Edit ─────────────────────────────────────────────────────────────────
  const startEdit = useCallback((s: MCPServerEntry) => {
    setEditingId(s.id);
    setEditForm({
      id: s.id,
      command: s.command ?? '',
      url: s.url ?? '',
      argsText: s.args.join(' '),
      envText: Object.entries(s.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    });
    setIsAdding(false);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editForm || !editingId) return;

    const server: MCPServerEntry = {
      id: editForm.id,
      args: parseArgsText(editForm.argsText),
      env: parseEnvText(editForm.envText),
    };
    if (editForm.command) server.command = editForm.command;
    if (editForm.url) server.url = editForm.url;

    const updated = { ...mcpServers };
    // If ID changed, remove old entry
    if (editingId !== editForm.id && editingId in updated) {
      delete updated[editingId];
    }
    updated[editForm.id] = serverToDict(server);

    onChange(updated);
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
  }, [editForm, editingId, mcpServers, onChange]);

  // ── Delete ───────────────────────────────────────────────────────────────
  const deleteServer = useCallback(
    (id: string) => {
      const updated = { ...mcpServers };
      delete updated[id];
      onChange(updated);
    },
    [mcpServers, onChange],
  );

  // ── Add ──────────────────────────────────────────────────────────────────
  const startAdd = useCallback(() => {
    setEditingId(null);
    setEditForm({
      id: '',
      command: '',
      url: '',
      argsText: '',
      envText: '',
    });
    setIsAdding(true);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">
          <span>MCP Servers</span>
          {!isAdding && (
            <button
              className="btn btn-ghost btn-xs font-normal text-primary hover:bg-primary/10"
              onClick={startAdd}
              type="button"
            >
              + Add Server
            </button>
          )}
        </div>

        <div className="config-card-list">
          {serverList.map((s) => (
            <div key={s.id} className="config-card">
              {editingId === s.id && editForm ? (
                <div className="flex flex-col gap-4">
                  <div className="config-form-grid">
                    <div className="config-field">
                      <label>Server ID</label>
                      <input
                        type="text"
                        value={editForm.id}
                        onChange={(e) => setEditForm({ ...editForm, id: e.target.value })}
                        className="input config-control"
                      />
                    </div>
                    <div className="config-field">
                      <label>Command</label>
                      <input
                        type="text"
                        value={editForm.command}
                        onChange={(e) => setEditForm({ ...editForm, command: e.target.value })}
                        className="input config-control"
                        placeholder="npx"
                      />
                    </div>
                    <div className="config-field">
                      <label>URL (for SSE servers)</label>
                      <input
                        type="text"
                        value={editForm.url}
                        onChange={(e) => setEditForm({ ...editForm, url: e.target.value })}
                        className="input config-control"
                        placeholder="http://localhost:3000"
                      />
                    </div>
                    <div className="config-field">
                      <label>Arguments (space-separated)</label>
                      <input
                        type="text"
                        value={editForm.argsText}
                        onChange={(e) => setEditForm({ ...editForm, argsText: e.target.value })}
                        className="input config-control"
                        placeholder="-y @upstash/context7-mcp"
                      />
                    </div>
                    <div className="config-field config-form-grid-full">
                      <label>Environment Variables (KEY=VALUE per line)</label>
                      <textarea
                        value={editForm.envText}
                        onChange={(e) => setEditForm({ ...editForm, envText: e.target.value })}
                        className="textarea config-textarea"
                        rows={3}
                        placeholder="API_KEY=sk-..."
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button className="btn btn-ghost btn-sm" onClick={cancelEdit} type="button">
                      Cancel
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={saveEdit} type="button">
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="config-card-row">
                  <div className="min-w-0">
                    <div className="config-card-title">{s.id}</div>
                    <p className="config-card-desc truncate">
                      {s.command ?? s.url ?? '(no command/url)'}
                    </p>
                    {s.args.length > 0 && (
                      <p className="config-card-desc mt-1 font-mono truncate">{s.args.join(' ')}</p>
                    )}
                  </div>
                  <DefinitionActions
                    onEdit={() => startEdit(s)}
                    onDelete={() => deleteServer(s.id)}
                  />
                </div>
              )}
            </div>
          ))}

          {isAdding && editForm && (
            <div className="config-card border-primary/30 bg-primary/5">
              <div className="config-card-title mb-3 text-primary">New Server</div>
              <div className="config-form-grid">
                <div className="config-field">
                  <label>Server ID</label>
                  <input
                    type="text"
                    value={editForm.id}
                    onChange={(e) => setEditForm({ ...editForm, id: e.target.value })}
                    className="input config-control"
                    placeholder="my-mcp-server"
                  />
                </div>
                <div className="config-field">
                  <label>Command</label>
                  <input
                    type="text"
                    value={editForm.command}
                    onChange={(e) => setEditForm({ ...editForm, command: e.target.value })}
                    className="input config-control"
                    placeholder="npx"
                  />
                </div>
                <div className="config-field">
                  <label>URL (for SSE servers)</label>
                  <input
                    type="text"
                    value={editForm.url}
                    onChange={(e) => setEditForm({ ...editForm, url: e.target.value })}
                    className="input config-control"
                    placeholder="http://localhost:3000"
                  />
                </div>
                <div className="config-field">
                  <label>Arguments (space-separated)</label>
                  <input
                    type="text"
                    value={editForm.argsText}
                    onChange={(e) => setEditForm({ ...editForm, argsText: e.target.value })}
                    className="input config-control"
                    placeholder="-y @upstash/context7-mcp"
                  />
                </div>
                <div className="config-field config-form-grid-full">
                  <label>Environment Variables (KEY=VALUE per line)</label>
                  <textarea
                    value={editForm.envText}
                    onChange={(e) => setEditForm({ ...editForm, envText: e.target.value })}
                    className="textarea config-textarea"
                    rows={3}
                    placeholder="API_KEY=sk-..."
                  />
                </div>
              </div>
              <div className="mt-4 flex justify-end gap-2">
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit} type="button">
                  Cancel
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={saveEdit}
                  disabled={!editForm.id}
                  type="button"
                >
                  Add Server
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
