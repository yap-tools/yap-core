/** MCP client helper for integration tests (streamable HTTP + bearer key). */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpTestClient {
  client: Client;
  /** Calls a tool and parses its text content as JSON (or returns raw text). */
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

export async function connectMcp(baseUrl: string, accessKey: string): Promise<McpTestClient> {
  const client = new Client({ name: "yap-tests", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessKey}` } },
  });
  await client.connect(transport);
  const callRaw = async (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  return {
    client,
    callRaw,
    call: async (name, args = {}) => {
      const result: any = await callRaw(name, args);
      if (result.isError) {
        const text = result.content?.map((c: any) => c.text).join("\n") ?? "tool error";
        throw new Error(text);
      }
      const text = result.content?.find((c: any) => c.type === "text")?.text;
      if (text === undefined) return result;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    },
    close: () => client.close(),
  };
}
