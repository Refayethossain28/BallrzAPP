// Client SMS notifications. Real Twilio when TWILIO_ACCOUNT_SID +
// TWILIO_AUTH_TOKEN + TWILIO_FROM are set; otherwise messages are composed and
// logged to the notifications feed, so the whole flow runs with no secrets.
// Uses Twilio's REST API directly (one fetch) — no SDK dependency needed.

export function notifyMode() {
  return process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM
    ? "twilio" : "log";
}

/**
 * Send an SMS (or log it in demo mode).
 * @returns {Promise<{channel:string,status:string}>}
 */
export async function sendSMS(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;

  if (sid && token && from && to) {
    try {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) return { channel: "sms", status: "sent" };
      const err = await res.text();
      console.warn("[notify] Twilio error:", err.slice(0, 200));
    } catch (e) {
      console.warn("[notify] Twilio failed:", e.message);
    }
  }
  // Demo mode / no phone / provider failure: the message still lands in the
  // notifications feed so the operator sees exactly what would have been sent.
  return { channel: "log", status: to ? "logged" : "no-phone" };
}

// Short per-event texts (kept terse on purpose — confirmations use the AI draft).
export function eventMessage(event, r) {
  const p = r.parsed_payload || {};
  const who = r.client_name && !/^(new client|guest)$/i.test(r.client_name) ? ` ${r.client_name}` : "";
  switch (event) {
    case "confirmed":
      return `Fixr: your ${r.type === "concierge" ? "request" : "booking"} is confirmed` +
        (p.datetime && p.datetime !== "—" ? ` for ${p.datetime}` : "") + `.`;
    case "enroute":
      return `Fixr: your chauffeur is on the way${p.pickup ? ` to ${p.pickup}` : ""}.` +
        (p.flight ? ` We're tracking flight ${p.flight}.` : "");
    case "completed":
      return `Fixr: trip complete${r.quote_amount ? ` — $${r.quote_amount} charged to your card on file` : ""}. Thank you${who}.`;
    case "fee":
      return `Fixr: your concierge request is arranged — service fee $${r.quote_amount}. Reply to adjust anything.`;
    default:
      return `Fixr: update on your ${r.type === "concierge" ? "request" : "booking"}.`;
  }
}
