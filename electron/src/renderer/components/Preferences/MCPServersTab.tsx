/**
 * MCPServersTab — list, edit, delete, and add MCP servers.
 *
 * Each server uses exactly one transport:
 * - stdio: command + args + env (spawns a child process)
 * - http:  url + headers (connects to a remote endpoint)
 *
 * Changes to MCP servers trigger a restart prompt.
 */
import { useState, useCallback } from 'react';
import { DefinitionActions } from './DefinitionActions';
import { Button } from '../ui/Button';
import { ConfigCard } from '../ui/ConfigCard';
import { FormField } from '../ui/FormField';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';
import { TextInput } from '../ui/TextInput';

// ── Types ────────────────────────────────────────────────────────────────────

type TransportType = 'stdio' | 'http';

export interface MCPServerEntry {
  id: string;
  transport: TransportType;
  command?: string;
  url?: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface MCPServersTabProps {
  mcpServers: Record<string, Record<string, unknown>>;
  onChange: (servers: Record<string, Record<string, unknown>>) => void;
}

interface EditingServer {
  id: string;
  transport: TransportType;
  command: string;
  url: string;
  argsText: string; // space-separated or JSON array
  envText: string; // KEY=VALUE per line
  authToken: string;
  headers: Record<string, string>; // non-auth headers, preserved across edits
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseServer(id: string, data: Record<string, unknown>): MCPServerEntry {
  const args = data.args;
  const env = data.env;
  const headers = data.headers;
  const transport: TransportType = data.url ? 'http' : 'stdio';
  return {
    id,
    transport,
    command: data.command as string | undefined,
    url: data.url as string | undefined,
    args: Array.isArray(args) ? (args as string[]) : [],
    env: env && typeof env === 'object' ? (env as Record<string, string>) : {},
    headers:
      headers && typeof headers === 'object'
        ? (headers as Record<string, string>)
        : {},
  };
}

function serverToDict(s: MCPServerEntry): Record<string, unknown> {
  const dict: Record<string, unknown> = {};
  if (s.transport === 'http') {
    if (s.url) dict.url = s.url;
    if (Object.keys(s.headers).length > 0) dict.headers = s.headers;
  } else {
    if (s.command) dict.command = s.command;
    if (s.args.length > 0) dict.args = s.args;
    if (Object.keys(s.env).length > 0) dict.env = s.env;
    const nonAuthHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers)) {
      if (k !== 'Authorization') nonAuthHeaders[k] = v;
    }
    if (Object.keys(nonAuthHeaders).length > 0) dict.headers = nonAuthHeaders;
  }
  return dict;
}

function parseArgsText(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as string[];
    } catch {
      // fall through
    }
  }
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

function extractAuthToken(headers: Record<string, string>): string {
  const auth = headers['Authorization'] ?? '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
}

function withoutAuth(headers: Record<string, string>): Record<string, string> {
  const rest: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k !== 'Authorization') rest[k] = v;
  }
  return rest;
}

// ── Component ────────────────────────────────────────────────────────────────

export function MCPServersTab({ mcpServers, onChange }: MCPServersTabProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditingServer | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const serverList = Object.entries(mcpServers).map(([id, data]) =>
    parseServer(id, data),
  );

  const startEdit = useCallback((s: MCPServerEntry) => {
    setEditingId(s.id);
    setEditForm({
      id: s.id,
      transport: s.transport,
      command: s.command ?? '',
      url: s.url ?? '',
      argsText: s.args.join(' '),
      envText: Object.entries(s.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      authToken: extractAuthToken(s.headers),
      headers: withoutAuth(s.headers),
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
      transport: editForm.transport,
      args: parseArgsText(editForm.argsText),
      env: parseEnvText(editForm.envText),
      headers: { ...editForm.headers },
    };

    if (editForm.transport === 'stdio') {
      if (editForm.command) server.command = editForm.command;
    } else {
      if (editForm.url) server.url = editForm.url;
      if (editForm.authToken) {
        server.headers = {
          ...editForm.headers,
          Authorization: `Bearer ${editForm.authToken}`,
        };
      }
    }

    const updated = { ...mcpServers };
    if (editingId !== editForm.id && editingId in updated) {
      delete updated[editingId];
    }
    updated[editForm.id] = serverToDict(server);

    onChange(updated);
    setEditingId(null);
    setEditForm(null);
    setIsAdding(false);
  }, [editForm, editingId, mcpServers, onChange]);

  const deleteServer = useCallback(
    (id: string) => {
      const updated = { ...mcpServers };
      delete updated[id];
      onChange(updated);
    },
    [mcpServers, onChange],
  );

  const startAdd = useCallback(() => {
    setEditingId(null);
    setEditForm({
      id: '',
      transport: 'stdio',
      command: '',
      url: '',
      argsText: '',
      envText: '',
      authToken: '',
      headers: {},
    });
    setIsAdding(true);
  }, []);

  const renderEditor = (form: EditingServer, title: string | null) => (
    <div className="flex flex-col gap-4">
      {title && <div className="config-card-title text-primary font-semibold">{title}</div>}
      <div className="config-form-grid">
        <FormField label="Transport" className="config-field config-form-grid-full">
          <div
            className="flex gap-1 rounded-box border border-base-300 bg-base-200/60 p-0.5 w-fit"
            role="group"
            aria-label="MCP server transport"
          >
            <Button
              type="button"
              size="xs"
              variant={form.transport === 'stdio' ? 'primary' : 'ghost'}
              className={[
                'h-7 min-h-7 border-0 shadow-none font-medium',
                form.transport === 'stdio'
                  ? ''
                  : 'bg-transparent text-base-content/70 hover:bg-base-300/60',
              ].join(' ')}
              aria-pressed={form.transport === 'stdio'}
              onClick={() => setEditForm({ ...form, transport: 'stdio' })}
            >
              Command (stdio)
            </Button>
            <Button
              type="button"
              size="xs"
              variant={form.transport === 'http' ? 'primary' : 'ghost'}
              className={[
                'h-7 min-h-7 border-0 shadow-none font-medium',
                form.transport === 'http'
                  ? ''
                  : 'bg-transparent text-base-content/70 hover:bg-base-300/60',
              ].join(' ')}
              aria-pressed={form.transport === 'http'}
              onClick={() => setEditForm({ ...form, transport: 'http' })}
            >
              URL (HTTP)
            </Button>
          </div>
        </FormField>
        <FormField label="Server ID" htmlFor="mcp-server-id" className="config-field">
          <TextInput
            id="mcp-server-id"
            type="text"
            value={form.id}
            onChange={(e) => setEditForm({ ...form, id: e.target.value })}
            bordered
            className="w-full"
            placeholder="my-mcp-server"
          />
        </FormField>
        {form.transport === 'stdio' ? (
          <>
            <FormField label="Command" htmlFor="mcp-server-command" className="config-field">
              <TextInput
                id="mcp-server-command"
                type="text"
                value={form.command}
                onChange={(e) => setEditForm({ ...form, command: e.target.value })}
                bordered
                className="w-full"
                placeholder="npx"
              />
            </FormField>
            <FormField
              label="Arguments (space-separated)"
              htmlFor="mcp-server-args"
              className="config-field"
            >
              <TextInput
                id="mcp-server-args"
                type="text"
                value={form.argsText}
                onChange={(e) => setEditForm({ ...form, argsText: e.target.value })}
                bordered
                className="w-full"
                placeholder="-y @upstash/context7-mcp"
              />
            </FormField>
            <FormField
              label="Environment Variables (KEY=VALUE per line)"
              htmlFor="mcp-server-env"
              className="config-field config-form-grid-full"
            >
              <textarea
                id="mcp-server-env"
                value={form.envText}
                onChange={(e) => setEditForm({ ...form, envText: e.target.value })}
                className="textarea textarea-bordered w-full"
                rows={3}
                placeholder="API_KEY=sk-..."
              />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="URL" htmlFor="mcp-server-url" className="config-field">
              <TextInput
                id="mcp-server-url"
                type="text"
                value={form.url}
                onChange={(e) => setEditForm({ ...form, url: e.target.value })}
                bordered
                className="w-full"
                placeholder="http://localhost:3000"
              />
            </FormField>
            <FormField
              label="Auth Token"
              htmlFor="mcp-server-token"
              className="config-field"
              hint="Sent as an Authorization: Bearer header."
            >
              <TextInput
                id="mcp-server-token"
                type="password"
                value={form.authToken}
                onChange={(e) => setEditForm({ ...form, authToken: e.target.value })}
                bordered
                className="w-full"
                placeholder="Bearer token"
                autoComplete="off"
              />
            </FormField>
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancelEdit} type="button">
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={saveEdit}
          disabled={!form.id}
          type="button"
        >
          {isAdding ? 'Add Server' : 'Save'}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader
          title="MCP Servers"
          actions={
            !isAdding ? (
              <Button
                variant="ghost"
                size="xs"
                className="font-normal text-primary hover:bg-primary/10"
                onClick={startAdd}
                type="button"
              >
                + Add Server
              </Button>
            ) : undefined
          }
        />

        <div className="config-card-list">
          {serverList.map((s) => (
            <ConfigCard key={s.id}>
              <ConfigCard.Body>
                {editingId === s.id && editForm ? (
                  renderEditor(editForm, null)
                ) : (
                  <div className="config-card-row flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="config-card-title font-semibold">{s.id}</div>
                      <p className="config-card-desc truncate text-sm text-base-content/70">
                        {s.command ?? s.url ?? '(no command/url)'}
                      </p>
                      {s.args.length > 0 && (
                        <p className="config-card-desc mt-1 font-mono truncate text-xs text-base-content/60">
                          {s.args.join(' ')}
                        </p>
                      )}
                    </div>
                    <DefinitionActions
                      onEdit={() => startEdit(s)}
                      onDelete={() => deleteServer(s.id)}
                    />
                  </div>
                )}
              </ConfigCard.Body>
            </ConfigCard>
          ))}

          {isAdding && editForm && (
            <ConfigCard variant="active">
              <ConfigCard.Body>{renderEditor(editForm, 'New Server')}</ConfigCard.Body>
            </ConfigCard>
          )}

          {!isAdding && serverList.length === 0 && (
            <StateMessage
              kind="empty"
              title="No MCP servers configured"
              className="py-4"
            />
          )}
        </div>
      </Panel>
    </div>
  );
}
