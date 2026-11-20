import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const TOPICS = ["delivery", "pricing", "other"];
const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 10_000;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Returns the request text, or null when the input is invalid.
async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) return null;
  try {
    const text = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.text;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

// The race guarantees the time limit even if the model ignores the signal.
function askModel(text) {
  const signal = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  const timeout = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([classify(text, { signal }), timeout]);
}

// Returns { topic, draft } for a valid model answer, otherwise null.
export function checkModelOutput(raw) {
  let output;
  try {
    output = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!output || typeof output !== "object") return null;
  const { topic, draft } = output;
  if (!TOPICS.includes(topic)) return null;
  if (typeof draft !== "string" || !draft.trim()) return null;
  return { topic, draft };
}

async function handleTriage(request, response) {
  const text = await readText(request);
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let result = null;
  try {
    result = checkModelOutput(await askModel(text));
  } catch {
    // Timeout or model error: fall through to manual review.
  }
  if (!result) return json(response, 200, { status: "manual_review", topic: null, draft: null });
  return json(response, 200, { status: "ready", ...result });
}

export const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
