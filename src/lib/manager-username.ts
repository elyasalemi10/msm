// Pure helpers for the manager email-username system (Item 15). NO
// "server-only" gate here so the file can be imported from modules that end
// up in the client bundle (e.g. via notifications.ts → email.ts). The DB
// helpers (isUsernameAvailable / findAvailableUsername) live in
// src/lib/manager-username-server.ts and DO carry "server-only".
//
// Outbound manager email is sent from `<email_username>@<brand-domain>`. The
// brand domain comes from RESEND_SUFFIX.
// The username is auto-derived at first onboarding from first_name + last_name.
// Managers can rename in /settings, but only once per 30 days. Every rename
// writes the old username to profile_username_aliases so legacy inbound mail
// still resolves.

const USERNAME_RX = /^[a-z0-9][a-z0-9._-]{1,38}[a-z0-9]$/;
export const USERNAME_CHANGE_COOLDOWN_DAYS = 30;

export function isValidUsername(u: string): boolean {
  if (!u) return false;
  return USERNAME_RX.test(u);
}

function slugify(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^-+|-+$/g, "");
}

// Returns the ordered list of preferred candidates to try in order. We attempt:
//   1. firstname.lastname
//   2. f.lastname
//   3. firstname.l
// The numeric fallback (firstname.lastname2, …) happens in the server helper
// once we know which ones are taken.
export function buildUsernameCandidates(firstName: string | null, lastName: string | null): string[] {
  const fn = slugify(firstName);
  const ln = slugify(lastName);
  const out: string[] = [];
  if (fn && ln) {
    out.push(`${fn}.${ln}`);
    out.push(`${fn[0]}.${ln}`);
    out.push(`${fn}.${ln[0]}`);
  } else if (fn) {
    out.push(fn);
  } else if (ln) {
    out.push(ln);
  }
  return out.filter((c) => isValidUsername(c));
}

export function slugifyForUsername(s: string | null | undefined): string {
  return slugify(s);
}

// Cooldown check used by the /settings rename action.
export function daysSince(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}

export function isWithinCooldown(lastChangedAt: Date | string | null | undefined): boolean {
  const days = daysSince(lastChangedAt);
  if (days === null) return false; // never changed → no cooldown
  return days < USERNAME_CHANGE_COOLDOWN_DAYS;
}

export function brandDomain(): string {
  return process.env.RESEND_SUFFIX?.trim() || "stratawise.com.au";
}

// RFC 5322 display names containing specials (comma, dot, angle brackets,
// quotes) must be quoted or the header is malformed and clients render the
// raw address instead of the name. Firm names like "Acme Strata Pty. Ltd."
// hit this, so every FROM header we build goes through here.
export function formatFrom(displayName: string, address: string): string {
  const name = displayName.trim();
  if (!name) return address;
  return /[()<>[\]:;@\\,."]/.test(name)
    ? `"${name.replace(/([\\"])/g, "\\$1")}" <${address}>`
    : `${name} <${address}>`;
}

// Composes the public-facing address. Always lowercase. If username is missing
// (e.g. lot_owner profile, or a manager who hasn't onboarded yet), returns null
// so callers fall back to the legacy noreply address.
export function managerEmailAddress(username: string | null | undefined): string | null {
  if (!username || !isValidUsername(username)) return null;
  return `${username.toLowerCase()}@${brandDomain()}`;
}

// Standardised FROM header for manager-initiated mail. Renders as
// "Manager Name - Company <username@brand-domain>" so the recipient sees who
// they're hearing from and which managing agency they represent. Falls back
// gracefully when either name component is missing.
export function managerEmailFrom(
  username: string | null | undefined,
  personName: string | null | undefined,
  companyName: string | null | undefined,
): string | null {
  const addr = managerEmailAddress(username);
  if (!addr) return null;
  const person = personName?.trim() || "";
  const company = companyName?.trim() || "StrataWise";
  const display = person ? `${person} - ${company}` : company;
  return formatFrom(display, addr);
}
