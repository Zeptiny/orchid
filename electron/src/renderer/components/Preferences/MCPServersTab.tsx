/**
 * MCPServersTab — list, edit, delete, and add MCP servers.
 *
 * Each server has: command (or url), args, env.
 * Changes to MCP servers trigger a restart prompt.
 */
import { useState, useCallback } from 'react';

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
    <div className="pref-tab-content">
      <div className="pref-tab-header">
        <h3>MCP Servers</h3>
        <p className="pref-tab-description">
          Configure Model Context Protocol tool servers. Changes require an app restart.
        </p>
      </div>

      {/* Server list */}
      <div className="pref-server-list">
        {serverList.map((s) => (
          <div key={s.id} className="pref-server-item">
            {editingId === s.id && editForm ? (
              /* Edit form */
              <div className="pref-server-edit">
                <div className="pref-form-row">
                  <label>Server ID</label>
                  <input
                    type="text"
                    value={editForm.id}
                    onChange={(e) =>
                      setEditForm({ ...editForm, id: e.target.value })
                    }
                    className="pref-input"
                  />
                </div>
                <div className="pref-form-row">
                  <label>Command</label>
                  <input
                    type="text"
                    value={editForm.command}
                    onChange={(e) =>
                      setEditForm({ ...editForm, command: e.target.value })
                    }
                    className="pref-input"
                    placeholder="npx"
                  />
                </div>
                <div className="pref-form-row">
                  <label>URL (for SSE servers)</label>
                  <input
                    type="text"
                    value={editForm.url}
                    onChange={(e) =>
                      setEditForm({ ...editForm, url: e.target.value })
                    }
                    className="pref-input"
                    placeholder="http://localhost:3000"
                  />
                </div>
                <div className="pref-form-row">
                  <label>Arguments (space-separated)</label>
                  <input
                    type="text"
                    value={editForm.argsText}
                    onChange={(e) =>
                      setEditForm({ ...editForm, argsText: e.target.value })
                    }
                    className="pref-input"
                    placeholder="-y @upstash/context7-mcp"
                  />
                </div>
                <div className="pref-form-row">
                  <label>Environment Variables (KEY=VALUE per line)</label>
                  <textarea
                    value={editForm.envText}
                    onChange={(e) =>
                      setEditForm({ ...editForm, envText: e.target.value })
                    }
                    className="pref-textarea"
                    rows={3}
                    placeholder="API_KEY=sk-..."
                  />
                </div>
                <div className="pref-form-actions">
                  <button className="btn btn-primary btn-sm" onClick={saveEdit}>
                    Save
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Display card */
              <div className="pref-server-card">
                <div className="pref-server-info">
                  <span className="pref-server-name">{s.id}</span>
                  <span className="pref-server-command">
                    {s.command ?? s.url ?? '(no command/url)'}
                  </span>
                  {s.args.length > 0 && (
                    <span className="pref-server-args">
                      {s.args.join(' ')}
                    </span>
                  )}
                </div>
                <div className="pref-server-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => startEdit(s)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => deleteServer(s.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add form (inline) */}
      {isAdding && editForm && (
        <div className="pref-server-add">
          <h4>Add MCP Server</h4>
          <div className="pref-form-row">
            <label>Server ID</label>
            <input
              type="text"
              value={editForm.id}
              onChange={(e) =>
                setEditForm({ ...editForm, id: e.target.value })
              }
              className="pref-input"
              placeholder="my-mcp-server"
            />
          </div>
          <div className="pref-form-row">
            <label>Command</label>
            <input
              type="text"
              value={editForm.command}
              onChange={(e) =>
                setEditForm({ ...editForm, command: e.target.value })
              }
              className="pref-input"
              placeholder="npx"
            />
          </div>
          <div className="pref-form-row">
            <label>URL (for SSE servers)</label>
            <input
              type="text"
              value={editForm.url}
              onChange={(e) =>
                setEditForm({ ...editForm, url: e.target.value })
              }
              className="pref-input"
              placeholder="http://localhost:3000"
            />
          </div>
          <div className="pref-form-row">
            <label>Arguments (space-separated)</label>
            <input
              type="text"
              value={editForm.argsText}
              onChange={(e) =>
                setEditForm({ ...editForm, argsText: e.target.value })
              }
              className="pref-input"
              placeholder="-y @upstash/context7-mcp"
            />
          </div>
          <div className="pref-form-row">
            <label>Environment Variables (KEY=VALUE per line)</label>
            <textarea
              value={editForm.envText}
              onChange={(e) =>
                setEditForm({ ...editForm, envText: e.target.value })
              }
              className="pref-textarea"
              rows={3}
              placeholder="API_KEY=sk-..."
            />
          </div>
          <div className="pref-form-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={saveEdit}
              disabled={!editForm.id}
            >
              Add Server
            </button>
            <button className="btn btn-ghost btn-sm" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Add button */}
      {!isAdding && (
        <button className="btn btn-secondary" onClick={startAdd}>
          + Add MCP Server
        </button>
      )}
    </div>
  );
}
