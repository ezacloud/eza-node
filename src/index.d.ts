export type TransactionStatus = "pending" | "completed" | "failed" | "cancelled" | "timed_out";

export interface Transaction {
  id: string;
  config_id: string;
  checkout_request_id: string | null;
  status: TransactionStatus;
  amount_kes: number;
  /** Masked, e.g. +254 712 ••• 678. */
  phone: string;
  account_reference: string;
  mpesa_receipt: string | null;
  result_description: string | null;
  livemode: boolean;
  created_at: string;
  settled_at: string | null;
}

export interface StkPushParams {
  /** 2547XXXXXXXX or 2541XXXXXXXX; 07… and +254… are accepted too. */
  phone: string;
  /** Whole KES, at least 1. */
  amount_kes: number;
  /** Letters, numbers and dashes, up to 12 characters. */
  account_reference: string;
  description?: string;
  /** Needed only when the organisation has more than one configuration. */
  config_id?: string;
  /** One per payment attempt. Generated when omitted. */
  idempotency_key?: string;
}

export type PaymentEventType = "payment.completed" | "payment.failed" | "payment.cancelled" | "payment.timed_out";

export interface PaymentEvent {
  /** The same across retries of one event: store it to skip duplicates. */
  id: string;
  type: PaymentEventType;
  created_at: string;
  livemode: boolean;
  data: {
    id: string;
    config_id: string;
    checkout_request_id: string | null;
    merchant_request_id: string | null;
    amount_kes: number;
    phone: string;
    account_reference: string;
    status: TransactionStatus;
    result_code: number | null;
    result_description: string | null;
    mpesa_receipt: string | null;
    created_at: string;
    settled_at: string | null;
  };
}

export type EmailEventType = "email.delivered" | "email.bounced" | "email.complained";

/** A webhook event: a payment from PayEdge, or an email's delivery. */
export interface WebhookEvent {
  /** The same across retries of one event: store it to skip duplicates. */
  id: string;
  type: PaymentEventType | EmailEventType;
  created_at: string;
  livemode: boolean;
  data: Record<string, unknown>;
}

export interface Attachment {
  filename: string;
  /** Bytes, or a base64 string. Up to 10 MB per message after encoding. */
  content: Uint8Array | ArrayBuffer | string;
  content_type?: string;
}

export interface SendEmailParams {
  /** "Shop <orders@mail.shop.co.ke>": a verified domain, or the sandbox. */
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  subject: string;
  html?: string;
  /** Generated from html when omitted. */
  text?: string;
  headers?: Record<string, string>;
  attachments?: Attachment[];
  tags?: { name: string; value: string }[];
  /** One per email you mean to send. Generated when omitted. */
  idempotency_key?: string;
}

export interface SentEmail {
  object: "email";
  id: string;
  from: string;
  /** Masked, e.g. w•••@gmail.com. */
  to: string[];
  subject: string;
  created_at: string;
  last_event: "queued" | "accepted" | "suppressed" | "delivered" | "deferred" | "bounced" | "complained" | "failed";
  tags: { name: string; value: string }[];
}

export interface EzaOptions {
  /** Defaults to EZA_API_KEY. PayEdge needs the payedge scope, email the email scope. */
  apiKey?: string;
  /** Defaults to apiKey, then EZA_EMAIL_KEY (set on every app on Eza). */
  emailKey?: string;
  /** Defaults to EZA_EMAIL_URL, then https://email.eza.co.ke. */
  emailUrl?: string;
  /** Defaults to https://payedge.eza.co.ke. */
  payedgeUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Milliseconds since the epoch; for tests. */
  now?: number;
}

export declare class EzaError extends Error {
  status: number;
  code: string;
  requestId: string | null;
  fields: { field: string; code: string; message: string }[];
}

export declare class SignatureError extends Error {}

export declare function verifyWebhook(
  body: string | Uint8Array,
  header: string | null | undefined,
  secret: string,
  options?: VerifyOptions,
): Promise<WebhookEvent>;

export declare class Emails {
  send(params: SendEmailParams): Promise<{ id: string }>;
  get(id: string): Promise<SentEmail>;
}

export declare class PayEdge {
  stkPush(params: StkPushParams): Promise<Transaction>;
  getTransaction(idOrCheckoutRequestId: string): Promise<Transaction>;
}

export declare class Eza {
  constructor(options?: EzaOptions);
  emails: Emails;
  payedge: PayEdge;
  webhooks: { verify: typeof verifyWebhook };
}

export default Eza;
