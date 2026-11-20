import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./server.mjs";

let url;

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/api/triage`;
});

after(() => server.close());

function post(body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
}

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`model failure ${marker} -> manual_review`, async () => {
    const reply = await post(JSON.stringify({ text: `Где моя доставка? ${marker}` }));
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
  });
}

test("timeout is limited by the server, not by the mock delay", async () => {
  const started = Date.now();
  await post(JSON.stringify({ text: "Заявка [timeout]" }));
  assert.ok(Date.now() - started < 1000, "response must not wait for the 1200 ms mock delay");
});

const invalidBodies = {
  "broken JSON": "{text:",
  "null body": "null",
  "array body": "[]",
  "string body": '"text"',
  "missing text": "{}",
  "non-string text": JSON.stringify({ text: 123 }),
  "empty text": JSON.stringify({ text: "" }),
  "whitespace text": JSON.stringify({ text: "   " }),
  "too large body": JSON.stringify({ text: "a".repeat(20_000) }),
};

for (const [name, body] of Object.entries(invalidBodies)) {
  test(`${name} -> 400 invalid_input`, async () => {
    const reply = await post(body);
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  });
}

test("valid request -> ready with topic and draft", async () => {
  const reply = await post(JSON.stringify({ text: "Какая цена доставки?" }));
  assert.equal(reply.status, 200);
  const body = await reply.json();
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "pricing");
  assert.ok(body.draft.trim());
});
