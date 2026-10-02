import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Eza, EzaError, SignatureError, verifyWebhook } from "../src/index.js";

// Signed by the Go gateway's webhooks.Sign: the SDKs must agree with it.
const vector = {
  secret: "whsec_test_0123456789abcdef",
  header: "t=1790538762,v1=5ed06d16182620e9aee7fd9d3b02a369038ccbdd656de90a45b004c9fc51c52b",
  body: '{"id":"evt_01","type":"payment.completed","livemode":false,"data":{"amount_kes":1500}}',
  now: 1790538762 * 1000 + 30_000,
};

async function serve(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, seen.length);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}

const tx = { id: "tx1", checkout_request_id: "ws_CO_1", status: "pending", amount_kes: 1500 };

test("stkPush sends the key, body and an idempotency key", async () => {
  const s = await serve((_, res) => {
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(tx));
  });
  const p = new Eza({ apiKey: "eza_live_k", payedgeUrl: s.url + "/" }).payedge;
  const out = await p.stkPush({ phone: "254712345678", amount_kes: 1500, account_reference: "INV1024" });
  s.close();
  assert.equal(out.checkout_request_id, "ws_CO_1");
  const r = s.seen[0];
  assert.equal(r.url, "/v1/stk-push");
  assert.equal(r.headers.authorization, "Bearer eza_live_k");
  assert.match(r.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(r.body.idempotency_key, r.headers["idempotency-key"]);
  assert.equal(r.body.amount_kes, 1500);
});

test("decimals are refused before sending", async () => {
  const p = new Eza({ apiKey: "k", fetch: () => assert.fail("sent") }).payedge;
  await assert.rejects(p.stkPush({ phone: "254712345678", amount_kes: 1.5, account_reference: "A" }), TypeError);
});

test("API errors carry the code, fields and request ID", async () => {
  const s = await serve((_, res) => {
    res.writeHead(422, { "Content-Type": "application/problem+json", "Eza-Request-Id": "req_1" });
    res.end(JSON.stringify({ code: "validation_failed", title: "Validation failed", errors: [{ field: "phone", code: "invalid", message: "Use 2547…" }] }));
  });
  const p = new Eza({ apiKey: "k", payedgeUrl: s.url }).payedge;
  const err = await p.stkPush({ phone: "0", amount_kes: 1, account_reference: "A" }).catch((e) => e);
  s.close();
  assert.ok(err instanceof EzaError);
  assert.equal(err.status, 422);
  assert.equal(err.code, "validation_failed");
  assert.equal(err.requestId, "req_1");
  assert.match(err.message, /phone: Use 2547/);
});

test("503 is retried with the same idempotency key; 502 is not", async () => {
  const s = await serve((_, res, n) => {
    res.writeHead(n === 1 ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(n === 1 ? { code: "internal_error" } : tx));
  });
  const p = new Eza({ apiKey: "k", payedgeUrl: s.url }).payedge;
  await p.stkPush({ phone: "254712345678", amount_kes: 5, account_reference: "A", idempotency_key: "order-9" });
  s.close();
  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[1].headers["idempotency-key"], "order-9");

  const s2 = await serve((_, res) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "mpesa_unavailable", detail: "Safaricom did not accept the prompt." }));
  });
  const p2 = new Eza({ apiKey: "k", payedgeUrl: s2.url }).payedge;
  const err = await p2.stkPush({ phone: "254712345678", amount_kes: 5, account_reference: "A" }).catch((e) => e);
  s2.close();
  assert.equal(err.code, "mpesa_unavailable");
  assert.equal(s2.seen.length, 1);
});

test("getTransaction escapes the reference", async () => {
  const s = await serve((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...tx, status: "completed" }));
  });
  const p = new Eza({ apiKey: "k", payedgeUrl: s.url }).payedge;
  const out = await p.getTransaction("ws_CO/1");
  s.close();
  assert.equal(out.status, "completed");
  assert.equal(s.seen[0].url, "/v1/transactions/ws_CO%2F1");
});

test("verifyWebhook accepts the gateway's signature", async () => {
  const ev = await verifyWebhook(vector.body, vector.header, vector.secret, { now: vector.now });
  assert.equal(ev.type, "payment.completed");
  const ev2 = await verifyWebhook(new TextEncoder().encode(vector.body), vector.header, vector.secret, { now: vector.now });
  assert.equal(ev2.id, "evt_01");
});

test("verifyWebhook refuses tampering, other secrets, old timestamps and junk", async () => {
  const bad = [
    [vector.body.replace("1500", "15000"), vector.header, vector.secret, vector.now],
    [vector.body, vector.header, "whsec_test_other", vector.now],
    [vector.body, vector.header, vector.secret, vector.now + 10 * 60_000],
    [vector.body, "v1=abc", vector.secret, vector.now],
    [vector.body, "", vector.secret, vector.now],
  ];
  for (const [body, header, secret, now] of bad) {
    await assert.rejects(verifyWebhook(body, header, secret, { now }), SignatureError);
  }
});

test("emails.send posts one email with an idempotency key", async () => {
  const s = await serve((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "01928f3e" }));
  });
  const eza = new Eza({ emailKey: "eza_live_mail", emailUrl: s.url });
  const out = await eza.emails.send({
    from: "Shop <orders@mail.shop.co.ke>",
    to: "wanjiku@gmail.com",
    subject: "Your receipt",
    html: "<p>Paid KES 1,500</p>",
    attachments: [{ filename: "receipt.txt", content: new TextEncoder().encode("KES 1,500") }],
  });
  s.close();
  assert.deepEqual(out, { id: "01928f3e" });
  const r = s.seen[0];
  assert.equal(r.url, "/emails");
  assert.equal(r.headers.authorization, "Bearer eza_live_mail");
  assert.match(r.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.deepEqual(r.body.to, ["wanjiku@gmail.com"], "one address becomes a list");
  assert.equal(r.body.attachments[0].content, Buffer.from("KES 1,500").toString("base64"));
  assert.equal(r.body.cc, undefined, "unset fields are left out");
});

test("on Eza, new Eza() sends email with the app's own settings", async () => {
  const s = await serve((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "e1" }));
  });
  const saved = { ...process.env };
  process.env.EZA_EMAIL_KEY = "eza_live_env";
  process.env.EZA_EMAIL_URL = s.url;
  delete process.env.EZA_API_KEY;
  try {
    const eza = new Eza();
    await eza.emails.send({ from: "a@b.co.ke", to: ["c@d.co.ke"], subject: "Hi", text: "Hi" });
    assert.equal(s.seen[0].headers.authorization, "Bearer eza_live_env");
    await assert.rejects(
      eza.payedge.stkPush({ phone: "254712345678", amount_kes: 1, account_reference: "A" }),
      /no API key for PayEdge/,
      "the email key is not used for PayEdge",
    );
  } finally {
    process.env = saved;
    s.close();
  }
});

test("email errors carry the API's name as the code; 429 is retried after Retry-After", async () => {
  const s = await serve((_, res, n) => {
    if (n === 1) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      return res.end(JSON.stringify({ statusCode: 429, name: "rate_limit_exceeded", message: "Slow down." }));
    }
    res.writeHead(403, { "Content-Type": "application/json", "Eza-Request-Id": "req_9" });
    res.end(JSON.stringify({ statusCode: 403, name: "domain_not_verified", message: "shop.co.ke is not a verified sending domain." }));
  });
  const eza = new Eza({ apiKey: "k", emailUrl: s.url });
  const err = await eza.emails.send({ from: "a@shop.co.ke", to: "x@y.co.ke", subject: "s", text: "t", idempotency_key: "k1" }).catch((e) => e);
  s.close();
  assert.equal(s.seen.length, 2);
  assert.equal(s.seen[1].headers["idempotency-key"], "k1", "the retry repeats the key");
  assert.ok(err instanceof EzaError);
  assert.equal(err.status, 403);
  assert.equal(err.code, "domain_not_verified");
  assert.equal(err.requestId, "req_9");
  assert.match(err.message, /not a verified sending domain/);
});

test("emails.send checks what it needs before sending", async () => {
  const eza = new Eza({ apiKey: "k", fetch: () => assert.fail("sent") });
  await assert.rejects(eza.emails.send({ to: "a@b.c", subject: "s", text: "t" }), /needs from/);
  await assert.rejects(eza.emails.send({ from: "a@b.c", to: [], subject: "s", text: "t" }), /needs to/);
  await assert.rejects(eza.emails.send({ from: "a@b.c", to: "a@b.c", subject: "s" }), /html, text or both/);
});

test("emails.get escapes the ID", async () => {
  const s = await serve((_, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "email", id: "a/b", last_event: "delivered" }));
  });
  const out = await new Eza({ apiKey: "k", emailUrl: s.url }).emails.get("a/b");
  s.close();
  assert.equal(out.last_event, "delivered");
  assert.equal(s.seen[0].url, "/emails/a%2Fb");
});
