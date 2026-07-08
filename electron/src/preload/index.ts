import { contextBridge, ipcRenderer } from 'electron';

/**
 * Expose IPC methods to the renderer process via contextBridge.
 * All IPC payloads are validated at the main-process boundary.
 */
contextBridge.exposeInMainWorld('orchid', {
  ipc: {
    /**
     * Send a chat message to the main process agent.
     * Returns a promise that resolves when the agent starts processing.
     */
    invoke: (channel: string, ...args: unknown[]) => {
      const allowedChannels = ['chat:send', 'chat:cancel'];
      if (!allowedChannels.includes(channel)) {
        throw new Error(`IPC channel '${channel}' is not allowed`);
      }
      return ipcRenderer.invoke(channel, ...args);
    },

    /**
     * Subscribe to streaming chat events from the main process.
     * Returns an unsubscribe function.
     */
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const allowedChannels = ['chat:chunk', 'chat:state', 'chat:done', 'chat:error'];
      if (!allowedChannels.includes(channel)) {
        throw new Error(`IPC channel '${channel}' is not allowed`);
      }
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
        callback(...args);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
});
