// Minimal MCP stdio server used by tests: tools/list + tools/call for "echo" and "wipe".
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } });
  else if (msg.method === "tools/list")
    send({ id: msg.id, result: { tools: [
      { name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
      { name: "wipe", description: "Delete everything", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
    ] } });
  else if (msg.method === "tools/call") send({ id: msg.id, result: { content: [{ type: "text", text: `echo: ${msg.params.arguments.text ?? ""}` }] } });
});
