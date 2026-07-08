/**
 * MCP client — public API.
 *
 * Usage:
 *   import { MCPManager } from './mcp';
 *   const manager = new MCPManager();
 *   await manager.startAll(config.mcp_servers, {
 *     perServerTimeout: config.mcp_per_server_timeout * 1000,
 *     startupTimeout: config.mcp_startup_timeout * 1000,
 *   });
 *
 * Lifecycle:
 *   await manager.startAll(servers);  // connect to all servers
 *   const tools = manager.getTools(); // get registered tools
 *   await manager.callTool(...);      // call an MCP tool
 *   await manager.shutdown();         // tear down all transports
 */
export { MCPManager } from './manager';
export { createTransport } from './transport';
export {
  mcpServerConfigSchema,
  isValidServerName,
  type MCPServerConfig,
  type MCPServerStatus,
  type MCPServerStatusValue,
} from './schema';
