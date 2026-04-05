#!/usr/bin/env node
/**
 * Vega Memory Remote MCP Client
 * Lightweight MCP server that proxies all tool calls to a remote Vega HTTP API.
 * No native dependencies required — works on Windows/Mac/Linux.
 * 
 * Usage: node vega-remote-mcp.mjs
 * Env: VEGA_SERVER_URL, VEGA_API_KEY
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_URL = process.env.VEGA_SERVER_URL || "http://localhost:3271";
const API_KEY = process.env.VEGA_API_KEY || "";

async function apiCall(path, method = "GET", body = undefined) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${err}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: "memory_store",
    description: "Store a memory entry in Vega Memory.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content" },
        type: { type: "string", enum: ["task_state","preference","project_context","decision","pitfall","insight"] },
        project: { type: "string" },
        title: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        importance: { type: "number" },
        source: { type: "string", enum: ["auto","explicit"], default: "auto" }
      },
      required: ["content", "type"]
    }
  },
  {
    name: "memory_recall",
    description: "Recall relevant memories from Vega Memory.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        project: { type: "string" },
        type: { type: "string" },
        limit: { type: "number", default: 5 },
        min_similarity: { type: "number", default: 0.3 }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_list",
    description: "List memories from Vega Memory.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        type: { type: "string" },
        limit: { type: "number", default: 20 },
        sort: { type: "string" }
      }
    }
  },
  {
    name: "memory_update",
    description: "Update an existing memory entry.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        importance: { type: "number" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["id"]
    }
  },
  {
    name: "memory_delete",
    description: "Delete a memory entry.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"]
    }
  },
  {
    name: "session_start",
    description: "Start a Vega Memory session.",
    inputSchema: {
      type: "object",
      properties: {
        working_directory: { type: "string" },
        task_hint: { type: "string" }
      },
      required: ["working_directory"]
    }
  },
  {
    name: "session_end",
    description: "End a Vega Memory session.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        summary: { type: "string" },
        completed_tasks: { type: "array", items: { type: "string" } }
      },
      required: ["project", "summary"]
    }
  },
  {
    name: "memory_health",
    description: "Return Vega Memory health information.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "memory_compact",
    description: "Compact Vega Memory.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" } }
    }
  }
];

const TOOL_ROUTES = {
  memory_store:   (args) => apiCall("/api/store", "POST", args),
  memory_recall:  (args) => apiCall("/api/recall", "POST", args),
  memory_list:    (args) => {
    const params = new URLSearchParams();
    if (args.project) params.set("project", args.project);
    if (args.type) params.set("type", args.type);
    if (args.limit) params.set("limit", String(args.limit));
    if (args.sort) params.set("sort", args.sort);
    return apiCall(`/api/list?${params}`);
  },
  memory_update:  (args) => apiCall(`/api/memory/${args.id}`, "PATCH", args),
  memory_delete:  (args) => apiCall(`/api/memory/${args.id}`, "DELETE"),
  session_start:  (args) => apiCall("/api/session/start", "POST", args),
  session_end:    (args) => apiCall("/api/session/end", "POST", args),
  memory_health:  ()     => apiCall("/api/health"),
  memory_compact: (args) => apiCall("/api/compact", "POST", args || {})
};

const server = new Server({ name: "vega-remote", version: "1.0.0" }, {
  capabilities: { tools: {} }
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_ROUTES[name];
  if (!handler) {
    return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }], isError: true };
  }
  try {
    const result = await handler(args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
