// Eza Cloud for Node.js: transactional email, PayEdge M-Pesa STK pushes,
// and signed webhooks. No dependencies; Node 18 or later (fetch and Web
// Crypto), and other runtimes with both.

const VERSION = "0.2.0";
const TOLERANCE_SECONDS = 300;
const URLS = { email: "https://email.eza.co.ke", payedge: "https://payedge.eza.co.ke" };

const env = (name) => globalThis.process?.env?.[name] || undefined;

/** An error an Eza API returned, or a network failure (status 0). */
export class EzaError extends Error {
  constructor(message, { status = 0, code = "network_error", requestId = null, fields = [] } = {}) {
    super(message);
    this.name = "EzaError";
    /** HTTP status; 0 when no response arrived. */
    this.status = status;
    /** Stable error code, such as validation_error, domain_not_verified or mpesa_unavailable. */
    this.code = code;
    /** Quote this to Eza support. */
    this.requestId = requestId;
    /** Field errors on a validation failure: [{ field, code, message }]. */
    this.fields = fields;
  }
}

/** A webhook whose signature or timestamp did not check out. */
export class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignatureError";
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newKey = () => globalThis.crypto.randomUUID();

export class Eza {
  /**
   * Every option has a default, so on Eza `new Eza()` is enough to send
   * email: apps receive EZA_EMAIL_KEY and EZA_EMAIL_URL.
   *
   * @param {object} [options]
   * @param {string} [options.apiKey] An Eza API key; defaults to EZA_API_KEY.
   *   PayEdge needs the payedge scope, email the email scope.
   * @param {string} [options.emailKey] A key for email only; defaults to
   *   apiKey, then EZA_EMAIL_KEY.
   * @param {string} [options.emailUrl] Defaults to EZA_EMAIL_URL, then https://email.eza.co.ke.
   * @param {string} [options.payedgeUrl] Defaults to https://payedge.eza.co.ke.
   * @param {number} [options.timeoutMs] Per request; defaults to 30 seconds.
   * @param {number} [options.maxRetries] Retries after a network error, a
   *   429 or a 503/504; defaults to 2. Sends and pushes always carry an
   *   idempotency key, so a retry never sends twice.
   * @param {typeof fetch} [options.fetch] For tests and other runtimes.
   */
  constructor({ apiKey, emailKey, emailUrl, payedgeUrl, timeoutMs = 30_000, maxRetries = 2, fetch: f } = {}) {
    this.keys = {
      payedge: apiKey ?? env("EZA_API_KEY"),
      email: emailKey ?? apiKey ?? env("EZA_EMAIL_KEY") ?? env("EZA_API_KEY"),
    };
    this.urls = {
      email: (emailUrl ?? env("EZA_EMAIL_URL") ?? URLS.email).replace(/\/+$/, ""),
      payedge: (payedgeUrl ?? URLS.payedge).replace(/\/+$/, ""),
    };
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = f ?? globalThis.fetch;
    this.emails = new Emails(this);
    this.payedge = new PayEdge(this);
    this.webhooks = { verify: verifyWebhook };
  }

  /** @internal */
  async request(product, method, path, body, headers = {}) {
    const key = this.keys[product];
    if (!key) {
      throw new TypeError(
        product === "email"
          ? "Eza: no API key for email: pass apiKey or set EZA_EMAIL_KEY (apps on Eza have it already)"
          : "Eza: no API key for PayEdge: pass apiKey (a key with the payedge scope) or set EZA_API_KEY",
      );
    }
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(this.urls[product] + path, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            "User-Agent": `eza-node/${VERSION}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new EzaError(`Eza: request failed: ${err?.message ?? err}`);
      }
      if ([429, 503, 504].includes(res.status) && attempt < this.maxRetries) {
        const after = Number(res.headers.get("retry-after"));
        await sleep(after > 0 ? Math.min(after, 10) * 1000 : 250 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        // not JSON: handled below
      }
      if (res.ok) return data;
      // PayEdge answers problem+json; the email API answers
      // { statusCode, name, message }.
      const requestId = res.headers.get("eza-request-id") ?? data?.request_id ?? null;
      let message = data?.detail || data?.message || data?.title || `HTTP ${res.status}`;
      if (data?.errors?.length) message = data.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
      throw new EzaError(`Eza: ${message}`, {
        status: res.status,
        code: data?.code ?? data?.name ?? "http_error",
        requestId,
        fields: data?.errors ?? [],
      });
    }
  }
}

const list = (v) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]);

function base64(content) {
  if (typeof content === "string") return content; // already base64
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  if (globalThis.Buffer) return globalThis.Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Transactional email: password resets, receipts, sign-in codes. */
export class Emails {
  #eza;
  constructor(eza) {
    this.#eza = eza;
  }

  /**
   * Sends one email and resolves to { id }. Until your domain is verified,
   * email only reaches members of your organisation. Repeating a call with
   * the same idempotency_key returns the first email's ID and sends nothing.
   */
  async send({ from, to, cc, bcc, reply_to, subject, html, text, headers, attachments, tags, idempotency_key } = {}) {
    if (!from) throw new TypeError("Eza: emails.send needs from");
    if (!to || (Array.isArray(to) && to.length === 0)) throw new TypeError("Eza: emails.send needs to");
    if (!subject) throw new TypeError("Eza: emails.send needs a subject");
    if (!html && !text) throw new TypeError("Eza: emails.send needs html, text or both");
    const key = idempotency_key ?? newKey();
    const body = { from, to: list(to), subject };
    const optional = { cc: list(cc), bcc: list(bcc), reply_to: list(reply_to), html, text, headers, tags };
    for (const [k, v] of Object.entries(optional)) if (v !== undefined) body[k] = v;
    if (attachments?.length) {
      body.attachments = attachments.map(({ filename, content, content_type }) => {
        if (!filename || content === undefined) throw new TypeError("Eza: each attachment needs filename and content");
        return { filename, content: base64(content), ...(content_type ? { content_type } : {}) };
      });
    }
    return this.#eza.request("email", "POST", "/emails", body, { "Idempotency-Key": key });
  }

  /** An email you sent: its status and last delivery event. Recipients are masked. */
  async get(id) {
    if (!id) throw new TypeError("Eza: emails.get needs an ID");
    return this.#eza.request("email", "GET", `/emails/${encodeURIComponent(id)}`);
  }
}

/** PayEdge: M-Pesa STK pushes to your own Paybill or Till. */
export class PayEdge {
  #eza;
  constructor(eza) {
    this.#eza = eza;
  }

  /**
   * Sends an STK push. Resolves when Safaricom has accepted the prompt; the
   * result arrives later at your webhook, or through getTransaction().
   * Repeating a call with the same idempotency_key returns the first
   * transaction instead of prompting again.
   */
  async stkPush({ phone, amount_kes, account_reference, description, config_id, idempotency_key } = {}) {
    if (!Number.isInteger(amount_kes)) {
      throw new TypeError("Eza: amount_kes must be a whole number of KES");
    }
    const key = idempotency_key ?? newKey();
    const body = { phone: String(phone), amount_kes, account_reference, idempotency_key: key };
    if (description !== undefined) body.description = description;
    if (config_id !== undefined) body.config_id = config_id;
    return this.#eza.request("payedge", "POST", "/v1/stk-push", body, { "Idempotency-Key": key });
  }

  /** A transaction by its ID or checkout_request_id. */
  async getTransaction(ref) {
    if (!ref) throw new TypeError("Eza: getTransaction needs an ID or checkout_request_id");
    return this.#eza.request("payedge", "GET", `/v1/transactions/${encodeURIComponent(ref)}`);
  }
}

function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * Checks a webhook's Eza-Signature header against the raw request body and
 * the endpoint's signing secret, and returns the parsed event. Pass the body
 * exactly as received (a string, Buffer or Uint8Array), not a re-serialised
 * object. Throws SignatureError when it does not check out.
 */
export async function verifyWebhook(body, header, secret, { toleranceSeconds = TOLERANCE_SECONDS, now = Date.now() } = {}) {
  if (!secret) throw new TypeError("Eza: the webhook signing secret is required");
  if (!header) throw new SignatureError("Missing Eza-Signature header");
  const raw = typeof body === "string" ? body : new TextDecoder().decode(body);
  let ts = null;
  const sigs = [];
  for (const part of String(header).split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t") ts = v;
    if (k === "v1" && v) sigs.push(v.toLowerCase());
  }
  if (!ts || !/^\d+$/.test(ts) || sigs.length === 0) throw new SignatureError("Malformed Eza-Signature header");
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSeconds) {
    throw new SignatureError("Webhook timestamp is outside the tolerance; possible replay");
  }
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = hex(await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${raw}`)));
  if (!sigs.some((s) => equal(s, want))) throw new SignatureError("Webhook signature does not match");
  return JSON.parse(raw);
}

export default Eza;
