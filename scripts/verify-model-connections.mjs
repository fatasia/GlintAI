import fs from "node:fs";
import { discoverLlmModels, AutoLlmProvider } from "../packages/llm/src/index.ts";
const baseUrl = process.env.GLINT_LLM_BASE_URL, apiKey = process.env.GLINT_LLM_API_KEY, out = process.env.GLINT_CONNECTION_OUT;
if (!baseUrl || !apiKey || !out) throw new Error("Set server-side LLM config and GLINT_CONNECTION_OUT");
const catalog = await discoverLlmModels(baseUrl, apiKey);
const results = [];
for (const model of (process.env.GLINT_TEST_MODELS ?? process.env.GLINT_LLM_MODEL ?? "").split(",").filter(Boolean)) {
  const started = performance.now(), provider = new AutoLlmProvider({ baseUrl, apiKey, model, reasoningEffort: "low" });
  try {
    const response = await provider.chat({ messages: [{ role: "user", content: "Reply with exactly GLINT_OK and nothing else." }], timeoutMs: 45000 });
    results.push({ model, protocol: provider.resolvedProtocol, elapsedMs: performance.now() - started, passed: response.text.trim() === "GLINT_OK" });
  } catch (error) { results.push({ model, passed: false, error: String(error).replaceAll(apiKey, "[redacted]").slice(0, 500) }); }
}
const report = { generatedAt: new Date().toISOString(), baseUrl, catalogCount: catalog.models.length, results, passed: results.length > 0 && results.every(result => result.passed) };
fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
