import readline from "node:readline";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Purpose-built offline ACP peer. Never starts a real agent or accesses credentials.
const directory = process.cwd(), waiting = new Map();
let nextId = 10000, config = "small";
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = value => send({ method: "session/update", params: { sessionId: "mock-session", update: value } });
const request = (method, params) => new Promise(resolve => { const id = ++nextId; waiting.set(id, resolve); send({ id, method, params }); });
const options = () => [{ id: "model", category: "model", name: "Model", type: "select", currentValue: config,
  options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] },
{ id: "approval", name: "Approval", type: "boolean", currentValue: false }];
readline.createInterface({ input: process.stdin }).on("line", async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message.method) { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
  const { id, method, params } = message;
  await appendFile(path.join(directory, "fixture-calls.jsonl"), JSON.stringify({ method, params }) + "\n");
  const reply = result => { if (id !== undefined) send({ id, result }); };
  if (method === "initialize") return reply({ protocolVersion: 1, agentInfo: { name: "offline-mock", version: "1" }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, authMethods: [] });
  if (method === "session/new" || method === "session/resume" || method === "session/load") {
    const project = JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"));
    if (project.title === "login") return send({ id, error: { code: -32000, message: "Authentication required" } });
    if (project.title === "unsupported" && method !== "session/new") return send({ id, error: { code: -32601, message: "unsupported" } });
    return reply({ sessionId: "mock-session", configOptions: options() });
  }
  if (method === "session/set_config_option") { config = params.value; return reply({ configOptions: options() }); }
  if (method === "session/prompt") {
    const instruction = JSON.parse(params.prompt[0].text.split("\n").at(-1)).instruction;
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "正在生成提案" } });
    if (instruction === "exit") return process.exit(7);
    if (instruction === "hang") return;
    if (instruction === "stderr") process.stderr.write("x".repeat(50000));
    if (instruction === "flood") for (let i = 0; i < 300; i++) update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: String(i) } });
    if (instruction === "permission") {
      const response = await request("session/request_permission", { sessionId: "mock-session", toolCall: { toolCallId: "write", title: "Write proposal", kind: "edit", status: "pending" },
        options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Allow always", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response.result) } });
      if (response.result?.outcome?.optionId !== "once") return reply({ stopReason: "cancelled" });
    }
    if (instruction === "question") {
      const response = await request("elicitation/create", { sessionId: "mock-session", mode: "form", message: "Title?", requestedSchema: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1, maxLength: 20 } } } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response.result) } });
    }
    if (instruction === "filesystem") {
      const response = await request("fs/read_text_file", { sessionId: "mock-session", path: path.join(directory, "project.json") });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ denied: !!response.error }) } });
    }
    if (instruction === "slow") await new Promise(resolve => setTimeout(resolve, 500));
    const project = JSON.parse(await readFile(path.join(directory, "project.json"), "utf8"));
    project.title = "提案标题";
    if (instruction === "wrong-id") project.id = "other";
    if (instruction === "locked") (project.tracks ?? project.scenes)[0].locked = false;
    await writeFile(path.join(directory, "proposal.json"), instruction === "invalid" ? "{}" : JSON.stringify(project));
    return reply({ stopReason: "end_turn" });
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: "Unsupported method" } });
});
