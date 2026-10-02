# Eza Cloud for Node.js

Transactional email, PayEdge M-Pesa STK pushes and signed webhooks. No
dependencies; Node.js 18 or later.

```sh
npm install @eza/sdk
```

## Email

On Eza, every app has `EZA_EMAIL_KEY` and `EZA_EMAIL_URL` already, so this
is all it takes:

```js
import { Eza } from "@eza/sdk";

const eza = new Eza();
const { id } = await eza.emails.send({
  from: "Shop <orders@mail.shop.co.ke>",
  to: "wanjiku@gmail.com",
  subject: "Your receipt",
  html: "<p>Thanks for your order.</p>",
});
```

Elsewhere, pass an API key with the `email` scope: `new Eza({ apiKey })`.
Until your sending domain is verified, email only reaches members of your
organisation. `emails.get(id)` returns an email's last delivery event.

Each send carries an idempotency key (pass `idempotency_key` to choose it),
so a retry never sends twice. Attachments take bytes:
`attachments: [{ filename: "receipt.pdf", content: pdfBuffer }]`.

## PayEdge

```js
const eza = new Eza({ apiKey: process.env.EZA_API_KEY }); // the payedge scope
const tx = await eza.payedge.stkPush({
  phone: "254712345678",
  amount_kes: 1500,
  account_reference: "INV1024",
});
// The result arrives at your webhook, or: await eza.payedge.getTransaction(tx.id)
```

## Webhooks

Verify the raw body, not a parsed object:

```js
import { verifyWebhook, SignatureError } from "@eza/sdk";

app.post("/hooks/eza", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body, req.get("Eza-Signature"), process.env.EZA_WEBHOOK_SECRET);
    // event.type: payment.completed, email.bounced, ...; store event.id to skip duplicates.
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(err instanceof SignatureError ? 400 : 500);
  }
});
```

## Errors

Every API error is an `EzaError` with `status`, `code` (such as
`domain_not_verified`, `email_limit_reached` or `mpesa_unavailable`),
`requestId` (quote it to support) and `fields` on validation errors.
