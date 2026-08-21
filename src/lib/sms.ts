import "server-only";

// Mobile Message API integration (Item 15 , Communications tab "Send SMS").
// Docs: https://mobilemessage.com.au/api-documentation
// Authentication: HTTP Basic with USERNAME + PASSWORD env vars.
// Endpoint: POST https://api.mobilemessage.com.au/v1/messages
//
// Manager confirmation is enforced UPSTREAM (the action requires an explicit
// `confirmed: true` flag because SMS sends cost money). This module just sends.

const ENDPOINT = "https://api.mobilemessage.com.au/v1/messages";

export interface SmsSendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

// The Mobile Message dashboard issues an "API key" string per account. Their
// HTTP Basic auth pairs the account username with that key in the password slot.
function mobileMessagePassword(): string | undefined {
  return process.env.MOBILE_MESSAGE_API_KEY;
}

// Normalises AU mobile numbers to E.164 (+61…). Accepts "04xxxxxxxx",
// "+614xxxxxxxx", "614xxxxxxxx", with spaces / dashes. Returns null if the
// number isn't a recognisable AU mobile.
export function normaliseAuMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+61") && digits.length === 12 && digits[3] === "4") return digits;
  if (digits.startsWith("61") && digits.length === 11 && digits[2] === "4") return `+${digits}`;
  if (digits.startsWith("04") && digits.length === 10) return `+61${digits.slice(1)}`;
  if (digits.startsWith("4") && digits.length === 9) return `+61${digits}`;
  return null;
}

export async function sendSms(params: {
  to: string;
  body: string;
  senderName?: string;
}): Promise<SmsSendResult> {
  const to = normaliseAuMobile(params.to);
  if (!to) return { ok: false, error: "Invalid mobile number." };
  if (!params.body?.trim()) return { ok: false, error: "Message body is required." };

  if (!process.env.MOBILE_MESSAGE_USERNAME || !mobileMessagePassword()) {
    console.error("[sms] Mobile Message credentials are not configured.");
    return { ok: false, error: "SMS is temporarily unavailable." };
  }

  const auth = Buffer.from(
    `${process.env.MOBILE_MESSAGE_USERNAME}:${mobileMessagePassword()}`,
  ).toString("base64");

  // Mobile Message rejects any sender id that isn't pre-approved on the
  // account. Falling back to "StrataWise" only works if that string has
  // been registered on the account.
  const sender =
    params.senderName ?? process.env.MOBILE_MESSAGE_SENDER_ID ?? "StrataWise";

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        messages: [
          {
            to,
            message: params.body,
            sender,
          },
        ],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[sms] send failed:", res.status, text);
      return { ok: false, error: `SMS provider returned ${res.status}` };
    }
    // Mobile Message returns HTTP 200 even when a per-message send fails
    // (e.g. unregistered sender id). The per-message status carries the
    // real outcome , treat anything that's not "success" as a failure so
    // the user sees the actual reason instead of a false "sent" toast.
    type MobileMessageResult = {
      status?: string;
      error?: string;
      message_id?: string;
    };
    const json =
      (await res.json().catch(() => null)) as {
        results?: MobileMessageResult[];
      } | null;
    const first = json?.results?.[0];
    if (first && first.status && first.status !== "success") {
      const reason = first.error || `provider rejected (${first.status})`;
      console.error("[sms] per-message failure:", reason, first);
      return { ok: false, error: `Could not send SMS , ${reason}` };
    }
    return { ok: true, id: first?.message_id };
  } catch (err) {
    console.error("[sms] send threw:", err);
    return { ok: false, error: "Could not send SMS , please try again." };
  }
}
