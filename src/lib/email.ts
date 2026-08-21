import { Resend } from "resend";
import { createServerClient } from "@/lib/supabase";
import { managerEmailFrom, brandDomain, formatFrom } from "@/lib/manager-username";
import { sendViaGmail, isGmailConfigured } from "@/lib/google/gmail-client";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Brand + sender configuration. The brand domain (e.g. "stratawise.com.au") is
// pulled from RESEND_SUFFIX via brandDomain(). Every manager-initiated
// send (invites, levies, overdue chase, payment receipts, claim updates,
// communications tab messages) resolves a FROM header of the form
// "Manager Name - Company <username@brand-domain>" via resolveManagerFromHeader
// or resolveOcSenderFromHeader. Only true system mail (email verification,
// password reset) stays on our own identity below.

// Our own identity. Only for mail the PLATFORM sends on its own behalf
// (email verification, password reset, system notices). Mail sent on behalf
// of a management firm must carry THEIR name , see orgNoreplyFrom.
function systemFrom(): string {
  return formatFrom("StrataWise", `noreply@${brandDomain()}`);
}

// Noreply identity for a management firm. Used when we're sending on the
// firm's behalf but can't resolve an individual manager's mailbox, so the
// owner still sees who the mail is actually from rather than "StrataWise".
function orgNoreplyFrom(companyName: string | null | undefined): string {
  const name = companyName?.trim();
  return name ? formatFrom(name, `noreply@${brandDomain()}`) : systemFrom();
}

// Trading name wins over legal name , it's what owners recognise.
async function companyDisplayName(companyId: string): Promise<string | null> {
  const supabase = createServerClient();
  const { data } = await supabase
    .from("management_companies")
    .select("name, trading_as")
    .eq("id", companyId)
    .maybeSingle();
  const c = data as { name: string | null; trading_as: string | null } | null;
  return c?.trading_as?.trim() || c?.name?.trim() || null;
}

// Looks up the trading name of a manager's own firm, for orgNoreplyFrom.
async function resolveManagerCompanyName(managerProfileId: string): Promise<string | null> {
  try {
    const supabase = createServerClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("management_company_id")
      .eq("id", managerProfileId)
      .maybeSingle();
    const companyId = (profile as { management_company_id: string | null } | null)?.management_company_id;
    return companyId ? await companyDisplayName(companyId) : null;
  } catch (err) {
    console.error("[email] resolveManagerCompanyName failed:", err);
    return null;
  }
}

// Looks up the trading name of the firm managing an OC, for orgNoreplyFrom.
async function resolveOcCompanyName(ocId: string): Promise<string | null> {
  try {
    const supabase = createServerClient();
    const { data: oc } = await supabase
      .from("owners_corporations")
      .select("management_company_id")
      .eq("id", ocId)
      .maybeSingle();
    const companyId = (oc as { management_company_id: string | null } | null)?.management_company_id;
    return companyId ? await companyDisplayName(companyId) : null;
  } catch (err) {
    console.error("[email] resolveOcCompanyName failed:", err);
    return null;
  }
}

// Resolves the personalised FROM header for a given manager profile. Returns
// null if the manager hasn't been assigned a username yet , callers fall back
// to resolveOcSenderFromHeader (OC's primary manager) or the noreply identity.
export async function resolveManagerFromHeader(
  managerProfileId: string,
): Promise<string | null> {
  try {
    const supabase = createServerClient();
    const { data } = await supabase
      .from("profiles")
      .select("email_username, first_name, last_name, management_company_id")
      .eq("id", managerProfileId)
      .maybeSingle();
    if (!data) return null;
    const personName =
      [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
    let companyName: string | null = null;
    if (data.management_company_id) {
      const { data: company } = await supabase
        .from("management_companies")
        .select("name, trading_as")
        .eq("id", data.management_company_id)
        .maybeSingle();
      companyName = company?.trading_as?.trim() || company?.name || null;
    }
    return managerEmailFrom(data.email_username, personName, companyName);
  } catch (err) {
    console.error("[email] resolveManagerFromHeader failed:", err);
    return null;
  }
}

// Resolves the FROM header for an OC-scoped send (levies, overdue notices,
// payment receipts, claim emails) when there's no specific manager initiating
// the action , e.g. a Trigger.dev cron or a reconciliation auto-match. Picks
// the longest-tenured active strata_manager for the OC. Falls back to the
// noreply identity when no manager is assigned yet.
export async function resolveOcSenderFromHeader(
  ocId: string | null | undefined,
): Promise<string> {
  if (!ocId) return systemFrom();
  try {
    const supabase = createServerClient();
    const { data: member } = await supabase
      .from("oc_members")
      .select("profile_id, joined_at")
      .eq("oc_id", ocId)
      .eq("role", "strata_manager")
      .is("left_at", null)
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const profileId = (member as { profile_id: string } | null)?.profile_id;
    if (profileId) {
      const from = await resolveManagerFromHeader(profileId);
      if (from) return from;
    }
  } catch (err) {
    console.error("[email] resolveOcSenderFromHeader failed:", err);
  }
  // No manager mailbox resolvable. Still send as the FIRM, not as us.
  return orgNoreplyFrom(await resolveOcCompanyName(ocId));
}

// ─── Unified transport (Gmail or Resend) ──────────────────────────────────
//
// Every manager-facing send (invitations, levies, overdue reminders,
// payment receipts, claim emails, manager messages) routes through here.
// True system-only sends , verification codes, password reset, Basiq
// system notifications , keep using getResend() directly because they
// represent the platform speaking on its own behalf, not on behalf of a
// management firm.
//
// Dispatch rules:
//   provider=gmail + JSON key present + we can resolve a sender mailbox
//     under the firm's domain → sendViaGmail (returns RFC822 Message-ID)
//   any retryable Gmail failure (rate limit after 1s retry) OR mailbox
//     can't be resolved OR provider=stratawise → fall through to Resend
//     with the caller's
//     `resendFrom` (a "Name <addr>" header).
//
// The "from-resolution" responsibility stays with the caller: we want each
// sender to make its own decision about *who* the "from" is so the audit
// trail captures intent (the inviter for invitations, the OC's primary
// manager for OC-scoped sends, the recipient profile for managerial
// notifications). The dispatcher just picks the TRANSPORT.

interface TransportSendOptions {
  /** Specific manager profile to impersonate (preferred). */
  managerProfileId?: string | null;
  /** OC scope , used to find the firm's primary manager when no
   *  managerProfileId is given. */
  ocId?: string | null;
  to: string;
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  /** FROM header used when we fall back to Resend. Required because we
   *  always know it server-side at the call site. */
  resendFrom: string;
}

async function transportSend(
  opts: TransportSendOptions,
): Promise<{ data: { id: string } | null; error: { message: string } | null }> {
  const { to, subject, html, attachments, resendFrom } = opts;

  // Resolve the manager profile we'd impersonate on Gmail.
  let managerProfileId = opts.managerProfileId ?? null;
  if (!managerProfileId && opts.ocId) {
    managerProfileId = await resolveOcPrimaryManagerProfileId(opts.ocId);
  }

  // Honour an explicit stratawise.com.au sender override (the manager
  // picked their stratawise alias / noreply in the send-emails dropdown).
  // Skip the Gmail provider entirely and go straight to Resend,
  // which holds the verified DKIM/SPF for stratawise.com.au. Without
  // this short-circuit the connected Gmail mailbox always wins, so the
  // dropdown choice had no effect.
  const forceResendForStratawise = /<[^>]*@stratawise\.com\.au>|@stratawise\.com\.au\b/i.test(resendFrom);

  if (managerProfileId && isGmailConfigured() && !forceResendForStratawise) {
    const dispatch = await resolveDispatchProvider(managerProfileId);
    if (dispatch.provider === "gmail") {
      const senderEmail = await resolveManagerSenderEmail(
        managerProfileId,
        dispatch.domain,
      );
      if (senderEmail) {
        const displayName = await resolveManagerDisplayName(managerProfileId);
        const result = await sendViaGmail({
          managerEmail: senderEmail,
          to,
          subject,
          htmlBody: html,
          fromDisplayName: displayName,
          attachments,
        });
        if (result.ok) {
          // Gmail's RFC822 Message-ID is what landed on the recipient's
          // headers, which is what their reply's In-Reply-To will quote.
          // Store THAT as the row's external_id so inbound webhook matches.
          return {
            data: { id: result.rfc822MessageId || result.messageId },
            error: null,
          };
        }
        if (!result.retryable) {
          return { data: null, error: { message: result.error } };
        }
        console.warn(
          "[email] Gmail rate-limited after retry, falling back to Resend.",
        );
      } else {
        console.warn(
          "[email] mail_provider=gmail but couldn't resolve a sender mailbox under domain",
          dispatch.domain,
          ", falling back to Resend.",
        );
      }
    }
  }

  return getResend().emails.send({
    from: resendFrom,
    to,
    subject,
    html,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  });
}

async function resolveOcPrimaryManagerProfileId(
  ocId: string,
): Promise<string | null> {
  try {
    const supabase = createServerClient();
    const { data } = await supabase
      .from("oc_members")
      .select("profile_id, joined_at")
      .eq("oc_id", ocId)
      .eq("role", "strata_manager")
      .is("left_at", null)
      .order("joined_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return (data as { profile_id: string } | null)?.profile_id ?? null;
  } catch (err) {
    console.error("[email] resolveOcPrimaryManagerProfileId failed:", err);
    return null;
  }
}

// Uniform result type for the owner-facing senders.
export type EmailSendResult =
  | { success: true; id: string | null }
  | { error: string };

interface SendInvitationEmailParams {
  to: string;
  inviteeName: string | null;
  role: "lot_owner" | "strata_manager";
  ocName: string;
  ocAddress: string;
  lotNumber?: number | null;
  inviteUrl: string;
  invitedByName?: string;
  companyLogoUrl?: string | null;
  // Optional resolved sender (e.g. inviter's "Name - Company <addr>"). When
  // omitted, the OC's primary manager is resolved and used. Final fallback
  // is the brand noreply identity.
  ocId?: string | null;
  inviterProfileId?: string | null;
}

// ─── Email verification (6-digit OTP) ──────────────────────────────────────
// Sent on sign-up and on resend requests. Our own gate , separate from
// Supabase Auth's built-in confirmation link (which is disabled). The code
// is plain 6-digit numeric, 10-minute expiry stored in email_verification_codes.

interface SendVerificationCodeEmailParams {
  to: string;
  name: string | null;
  code: string;
}

export async function sendPasswordResetCodeEmail({
  to,
  name,
  code,
}: SendVerificationCodeEmailParams): Promise<{ success: true } | { error: string }> {
  const greeting = name ? `Hi ${name},` : "Hi,";

  const { error } = await getResend().emails.send({
    from: systemFrom(),
    to,
    subject: `Your StrataWise password reset code: ${code}`,
    html: `
      <div style="font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px 0;">
        <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Reset your password</h2>
        <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
          ${greeting} use the code below on the StrataWise password-reset page to set a new password. It expires in 10 minutes.
        </p>
        <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:24px;margin:0 0 24px;text-align:center;">
          <p style="margin:0;font-size:40px;font-weight:700;letter-spacing:14px;color:#0E314C;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-variant-numeric:tabular-nums;">${code}</p>
        </div>
        <p style="margin:24px 0 0;color:#4A5868;font-size:12px;line-height:1.5;">
          If you didn't request a password reset, you can safely ignore this email , your password won't change.
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("Failed to send password reset email:", error);
    return { error: error.message ?? "Failed to send email" };
  }
  return { success: true as const };
}

export async function sendVerificationCodeEmail({
  to,
  name,
  code,
}: SendVerificationCodeEmailParams): Promise<{ success: true } | { error: string }> {
  const greeting = name ? `Hi ${name},` : "Hi,";

  const { error } = await getResend().emails.send({
    from: systemFrom(),
    to,
    subject: `Your StrataWise verification code: ${code}`,
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 0;">
        <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Verify your email</h2>
        <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
          ${greeting} use the code below to verify your StrataWise account. It expires in 10 minutes.
        </p>
        <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:24px;margin:0 0 24px;text-align:center;">
          <p style="margin:0;font-size:40px;font-weight:700;letter-spacing:14px;color:#0E314C;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-variant-numeric:tabular-nums;">${code}</p>
        </div>
        <p style="margin:24px 0 0;color:#4A5868;font-size:12px;line-height:1.5;">
          If you didn't request this code, you can safely ignore this email.
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("Failed to send verification code email:", error);
    return { error: error.message ?? "Failed to send email" };
  }
  return { success: true as const };
}

export async function sendInvitationEmail({
  to,
  inviteeName,
  role,
  ocName,
  ocAddress,
  lotNumber,
  inviteUrl,
  invitedByName,
  companyLogoUrl,
  ocId,
  inviterProfileId,
}: SendInvitationEmailParams) {
  const roleLabel = role === "lot_owner" ? "lot owner" : "strata manager";
  const greeting = inviteeName ? `Hi ${inviteeName},` : "Hi,";
  const lotLine = lotNumber ? `<p style="margin:0 0 8px;color:#4A5868;font-size:14px;">Lot: <strong>${lotNumber}</strong></p>` : "";
  const invitedByLine = invitedByName ? ` by ${invitedByName}` : "";

  const from =
    (inviterProfileId && (await resolveManagerFromHeader(inviterProfileId))) ||
    (await resolveOcSenderFromHeader(ocId ?? null));

  const { error } = await transportSend({
    managerProfileId: inviterProfileId ?? null,
    ocId: ocId ?? null,
    to,
    subject: `You've been invited to ${ocName}`,
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 0;">
        ${logoImg(companyLogoUrl)}
        <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">You've been invited</h2>
        <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
          ${greeting} you've been invited${invitedByLine} to join as a <strong>${roleLabel}</strong>.
        </p>
        <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
          <p style="margin:0 0 4px;font-size:15px;font-weight:600;color:#0E314C;">${ocName}</p>
          <p style="margin:0 0 8px;color:#4A5868;font-size:14px;">${ocAddress}</p>
          ${lotLine}
        </div>
        <a href="${inviteUrl}" style="display:inline-block;background:#CFA753;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:6px;">
          Accept invitation
        </a>
        <p style="margin:24px 0 0;color:#4A5868;font-size:12px;line-height:1.5;">
          This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      </div>
    `,
    resendFrom: from,
  });

  if (error) {
    console.error("Failed to send invitation email:", error);
    return { error: error.message };
  }

  return { success: true };
}

// ─── Levy Notice Email ─────────────────────────────────────

interface SendLevyEmailParams {
  to: string;
  ownerName: string | null;
  ocName: string;
  ocAddress: string;
  companyLogoUrl?: string | null;
  referenceNumber: string;
  dueDate: string;
  totalAmount: string;
  periodLabel: string;
  pdfBuffer: Buffer;
  pdfFilename: string;
  /** Optional extra files attached after the levy PDF. Caller is
   *  responsible for keeping the total payload under provider limits
   *  (Resend 40 MB / Gmail 25 MB). */
  extraAttachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  ocId?: string | null;
  /** Optional explicit sender address (e.g. picked by the manager in the
   *  send dialog). When set, overrides the OC-resolved default sender. */
  fromOverride?: string | null;
}

export async function sendLevyEmail({
  to,
  ownerName,
  ocName,
  ocAddress,
  companyLogoUrl,
  referenceNumber,
  dueDate,
  totalAmount,
  periodLabel,
  pdfBuffer,
  pdfFilename,
  extraAttachments,
  ocId,
  fromOverride,
}: SendLevyEmailParams) {
  const greeting = ownerName ? `Hi ${ownerName},` : "Hi,";
  const logoHtml = logoImg(companyLogoUrl);

  // Manager-picked override wins over the OC-resolved default. The
  // override is already a bare email so wrap it with the firm display
  // name when we have one; otherwise pass through as-is.
  const resolved = await resolveOcSenderFromHeader(ocId ?? null);
  const from = fromOverride && fromOverride.trim().length > 0
    ? fromOverride
    : resolved;

  const { error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject: `Levy Notice , ${ocName} , ${periodLabel}`,
    html: `
      <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 0;">
        ${logoHtml}
        <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Levy Notice</h2>
        <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
          ${greeting} a new levy notice has been issued for <strong>${ocAddress}</strong>.
        </p>
        <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
          <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Levy number</p>
          <p style="margin:0 0 12px;font-size:15px;font-weight:600;color:#0E314C;">${referenceNumber}</p>
          <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Due date</p>
          <p style="margin:0;font-size:14px;font-weight:600;color:#0E314C;">${dueDate}</p>
        </div>
        <p style="margin:0;color:#0E314C;font-size:14px;">
          Your levy notice is attached as a PDF. Please open it for the full breakdown, including any arrears or adjustments, and payment details.
        </p>
      </div>
    `,
    attachments: [
      {
        filename: pdfFilename,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
      ...(extraAttachments ?? []),
    ],
    resendFrom: from,
  });

  if (error) {
    console.error("Failed to send levy email:", error);
    return { error: error.message };
  }

  return { success: true };
}

// ─── Bank-feed system emails (Prompt 3) ───────────────────────────
// Plaintext-ish HTML. Copy polish is deferred to Prompt 6; these are
// the minimum needed to honour the 30/14/7/3/1-day reauth cadence, the
// expired notification, the gap reconciliation notice, and the
// committee notification on gaps > 30 days.

type BasiqEmailResult = { success: true } | { error: string };

async function sendSystemEmail(
  to: string,
  subject: string,
  bodyHtml: string,
): Promise<BasiqEmailResult> {
  // Dry-run gate (PP6-C-1) , also covers the original "no API key in dev"
  // case for backward compatibility (an unset key is still treated as
  // dry-run, so existing dev workflows without a key keep working).
  const { error } = await getResend().emails.send({
    from: systemFrom(),
    to,
    subject,
    html: bodyHtml,
  });
  if (error) {
    console.error("Failed to send system email:", error);
    return { error: error.message };
  }
  return { success: true };
}

export async function sendBasiqReauthReminderEmail(params: {
  to: string;
  ocName: string;
  daysRemaining: number;
  reauthUrl: string;
  companyLogoUrl?: string | null;
}): Promise<BasiqEmailResult> {
  const { to, ocName, daysRemaining, reauthUrl, companyLogoUrl } = params;
  const subject = `Bank feed reauthorisation required in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"} , ${ocName}`;
  const html = `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 0;">
      ${logoImg(companyLogoUrl)}
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#0E314C;">Bank feed expiring soon</h2>
      <p style="margin:0 0 16px;color:#0E314C;font-size:14px;line-height:1.5;">
        The automatic bank feed for <strong>${ocName}</strong> will expire in
        <strong>${daysRemaining} day${daysRemaining === 1 ? "" : "s"}</strong>. Reauthorise to keep transactions syncing.
      </p>
      <a href="${reauthUrl}" style="display:inline-block;background:#CFA753;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;">
        Reauthorise now
      </a>
      <p style="margin:16px 0 0;color:#4A5868;font-size:12px;">If the feed expires, CSV import remains available as a fallback.</p>
    </div>
  `;
  return sendSystemEmail(to, subject, html);
}

export async function sendBasiqConsentExpiredEmail(params: {
  to: string;
  ocName: string;
  reauthUrl: string;
  companyLogoUrl?: string | null;
}): Promise<BasiqEmailResult> {
  const { to, ocName, reauthUrl, companyLogoUrl } = params;
  const subject = `Bank feed disconnected , ${ocName}`;
  const html = `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 0;">
      ${logoImg(companyLogoUrl)}
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#b91c1c;">Bank feed disconnected</h2>
      <p style="margin:0 0 16px;color:#0E314C;font-size:14px;line-height:1.5;">
        The automatic bank feed for <strong>${ocName}</strong> has expired. New transactions will not be imported until you reauthorise.
      </p>
      <a href="${reauthUrl}" style="display:inline-block;background:#CFA753;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;">
        Reauthorise now
      </a>
      <p style="margin:16px 0 0;color:#4A5868;font-size:12px;">CSV import remains available as a fallback.</p>
    </div>
  `;
  return sendSystemEmail(to, subject, html);
}

export async function sendBasiqGapReconciliationEmail(params: {
  to: string;
  ocName: string;
  gapHours: number;
  backfilledCount: number;
  autoMatchedCount: number;
  manualReviewCount: number;
  reportUrl: string;
  companyLogoUrl?: string | null;
}): Promise<BasiqEmailResult> {
  const {
    to,
    ocName,
    gapHours,
    backfilledCount,
    autoMatchedCount,
    manualReviewCount,
    reportUrl,
    companyLogoUrl,
  } = params;
  const subject = `Bank feed reconnected , reconciliation gap report for ${ocName}`;
  const html = `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 0;">
      ${logoImg(companyLogoUrl)}
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#0E314C;">Bank feed reconnected</h2>
      <p style="margin:0 0 12px;color:#0E314C;font-size:14px;line-height:1.5;">
        The bank feed for <strong>${ocName}</strong> was disconnected for <strong>${gapHours} hour${gapHours === 1 ? "" : "s"}</strong>.
      </p>
      <ul style="margin:0 0 16px;padding-left:20px;color:#0E314C;font-size:14px;line-height:1.6;">
        <li>${backfilledCount} transaction${backfilledCount === 1 ? "" : "s"} imported during reconnection</li>
        <li>${autoMatchedCount} auto-matched</li>
        <li>${manualReviewCount} awaiting manual review</li>
      </ul>
      <p style="margin:0 0 16px;color:#0E314C;font-size:14px;line-height:1.5;">
        Arrears notifications are paused for 48 hours while you review.
      </p>
      <a href="${reportUrl}" style="display:inline-block;background:#CFA753;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:6px;">
        View gap report
      </a>
    </div>
  `;
  return sendSystemEmail(to, subject, html);
}

export async function sendBasiqCommitteeGapNotificationEmail(params: {
  to: string;
  ocName: string;
  gapHours: number;
  companyLogoUrl?: string | null;
}): Promise<BasiqEmailResult> {
  const { to, ocName, gapHours, companyLogoUrl } = params;
  const days = Math.round(gapHours / 24);
  const subject = `Extended bank-feed outage , ${ocName}`;
  const html = `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 0;">
      ${logoImg(companyLogoUrl)}
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#b45309;">Extended bank-feed outage</h2>
      <p style="margin:0 0 12px;color:#0E314C;font-size:14px;line-height:1.5;">
        The automatic bank feed for <strong>${ocName}</strong> was disconnected for approximately <strong>${days} days</strong>.
      </p>
      <p style="margin:0 0 0;color:#0E314C;font-size:14px;line-height:1.5;">
        During this time, arrears notifications may have been issued based on stale reconciliation state. A detailed gap report is available in the StrataWise dashboard.
      </p>
    </div>
  `;
  return sendSystemEmail(to, subject, html);
}

// ─── PP6-C-1: owner-facing transactional emails ──────────────────────────
// Inline HTML template literals (per PP6-0 ratification). Each sender
// returns the uniform EmailSendResult so emit helpers in
// src/lib/notifications.ts can persist the Resend message id into
// communication_log.external_id.

interface SharedSenderHeader {
  to: string;
  ownerName: string | null;
  ocName: string;
  ocAddress: string;
  // PP6-D-D-fix-logo: company logo URL resolved via the helper in
  // src/lib/notifications.ts:resolveCompanyLogo. Null/undefined →
  // text-only header (current management_companies typically have
  // logo_url=NULL until the manager UI for upload ships in 6.5).
  companyLogoUrl?: string | null;
  // OC id used by resolveOcSenderFromHeader to pick the active manager whose
  // identity becomes the FROM header. Optional , falls back to the brand
  // noreply identity when missing.
  ocId?: string | null;
}

function greeting(ownerName: string | null): string {
  return ownerName ? `Hi ${ownerName},` : "Hi,";
}

// PP6-D-D-fix-logo: shared <img> renderer for the company logo. Returns
// empty string when no logo is configured , callers can inline this at
// the top of any email body without conditionals.
function logoImg(url: string | null | undefined): string {
  return url
    ? `<img src="${url}" alt="" style="max-height:48px;max-width:160px;margin-bottom:16px;" />`
    : "";
}

function brandShell(innerHtml: string, logoUrl?: string | null): string {
  return `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 0;">
      ${logoImg(logoUrl)}
      ${innerHtml}
    </div>
  `;
}

// ─── sendPaymentReceivedEmail ──────────────────────────────────────────

export interface SendPaymentReceivedEmailParams extends SharedSenderHeader {
  amount: number;
  paymentDate: string;
  description: string;
  lotLabel: string;
  reference: string | null;
  ocShortCode: string;
}

export async function sendPaymentReceivedEmail(
  params: SendPaymentReceivedEmailParams,
): Promise<EmailSendResult> {
  const { to, ownerName, ocName, ocAddress, amount, paymentDate, description, lotLabel, reference, ocShortCode, companyLogoUrl, ocId } = params;
  const subject = `Payment received , ${ocName}`;

  const from = await resolveOcSenderFromHeader(ocId ?? null);

  const refLine = reference
    ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Reference</p><p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(reference)}</p>`
    : "";

  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "my-payments",
    "View payment history",
    "Log in to StrataWise to view your full payment history.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Payment received</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greeting(ownerName)} we've recorded a payment against your account at <strong>${escapeHtml(ocAddress)}</strong>.
    </p>
    <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Lot</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(lotLabel)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0E314C;">$${amount.toFixed(2)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Date</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(paymentDate)}</p>
      ${refLine}
      ${description ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Description</p><p style="margin:0;font-size:14px;color:#0E314C;">${escapeHtml(description)}</p>` : ""}
    </div>
    ${ctaBlock}
  `, companyLogoUrl);

  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    resendFrom: from,
  });
  if (error) {
    console.error("Failed to send payment_received email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── sendOverdueReminderEmail (PP6-C-1 step 1) ─────────────────────────

export interface SendOverdueReminderEmailParams extends SharedSenderHeader {
  referenceNumber: string;
  amountOutstanding: number;
  daysOverdue: number;
  dueDate: string;
  penaltyInterestAccrued: number; // 0 if no accrual yet
  ocShortCode: string;   // for /my-arrears CTA link
  // PP7-A: optional PDF attachment. When set, attached via Resend
  // attachments[]. Caller (escalation engine) resolves the buffer via
  // getLevyNoticePdfBuffer(levyId, supabase); null means body-only fallback.
  pdfBuffer?: Buffer | null;
  pdfFilename?: string;
}

export async function sendOverdueReminderEmail(
  params: SendOverdueReminderEmailParams,
): Promise<EmailSendResult> {
  const { to, ownerName, ocName, ocAddress, referenceNumber, amountOutstanding, daysOverdue, dueDate, penaltyInterestAccrued, ocShortCode, companyLogoUrl, pdfBuffer, pdfFilename, ocId } = params;
  const subject = `Your levy is overdue , ${ocName}`;

  const interestLine = penaltyInterestAccrued > 0
    ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Interest accrued</p><p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#dc2626;">$${penaltyInterestAccrued.toFixed(2)}</p>`
    : "";

  // PP6-D-D-fix: CTA hyperlink to the owner's my-arrears page. Fallback to
  // plain text when NEXT_PUBLIC_APP_URL is unset (avoids rendering a broken
  // anchor with a relative href).
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const ctaBlock = appBaseUrl
    ? `<p style="margin:0 0 16px;color:#0E314C;font-size:14px;line-height:1.6;">
        Click below to see your arrears, payment options, and full ledger.
      </p>
      <a href="${appBaseUrl}/ocs/${escapeHtml(ocShortCode)}/my-arrears" style="display:inline-block;background:#CFA753;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:6px;margin:0 0 24px;">
        View outstanding balance
      </a>`
    : `<p style="margin:0 0 24px;color:#0E314C;font-size:14px;">
        Log in to StrataWise to view your outstanding balance, payment options, and full ledger.
      </p>`;

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Levy overdue , friendly reminder</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greeting(ownerName)} our records show a levy at <strong>${escapeHtml(ocAddress)}</strong> is now <strong>${daysOverdue} days</strong> past its due date. If you've already paid, you can disregard this notice , it may take a day or two to reflect on our system.
    </p>
    <div style="background:#fef9f3;border:1px solid #fde7d0;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Reference</p>
      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#0E314C;">${escapeHtml(referenceNumber)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Original due date</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(dueDate)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount outstanding</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0E314C;">$${amountOutstanding.toFixed(2)}</p>
      ${interestLine}
    </div>
    ${ctaBlock}
    <p style="margin:0;color:#4A5868;font-size:12px;line-height:1.5;">
      Continued non-payment may result in further reminders and late fees in line with your strata rules.
    </p>
  `, companyLogoUrl);

  const from = await resolveOcSenderFromHeader(ocId ?? null);

  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    attachments: pdfBuffer
      ? [
          {
            filename: pdfFilename ?? `${referenceNumber}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ]
      : undefined,
    resendFrom: from,
  });
  if (error) {
    console.error("Failed to send overdue_reminder email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── sendClaimMatchedEmail ─────────────────────────────────────────────

export interface SendClaimMatchedEmailParams extends SharedSenderHeader {
  amount: number;
  claimDate: string;
  paymentMethod: string;
  lotLabel: string;
  ocShortCode: string;
}

export async function sendClaimMatchedEmail(
  params: SendClaimMatchedEmailParams,
): Promise<EmailSendResult> {
  const { to, ownerName, ocName, ocAddress, amount, claimDate, paymentMethod, lotLabel, ocShortCode, companyLogoUrl, ocId } = params;
  const subject = `Your payment has been confirmed , ${ocName}`;

  const from = await resolveOcSenderFromHeader(ocId ?? null);

  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "my-payments",
    "View payment confirmation",
    "Log in to StrataWise to view this confirmed payment.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Payment confirmed</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greeting(ownerName)} the payment claim you submitted for <strong>${escapeHtml(ocAddress)}</strong> has been matched and applied to your account.
    </p>
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Lot</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(lotLabel)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0E314C;">$${amount.toFixed(2)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Claimed date</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(claimDate)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Method</p>
      <p style="margin:0;font-size:14px;color:#0E314C;">${escapeHtml(paymentMethod)}</p>
    </div>
    ${ctaBlock}
  `, companyLogoUrl);

  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    resendFrom: from,
  });
  if (error) {
    console.error("Failed to send claim_matched email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── sendClaimRejectedEmail ────────────────────────────────────────────

export interface SendClaimRejectedEmailParams extends SharedSenderHeader {
  amount: number;
  claimDate: string;
  rejectionReason: string;
  lotLabel: string;
  ocShortCode: string;
}

export async function sendClaimRejectedEmail(
  params: SendClaimRejectedEmailParams,
): Promise<EmailSendResult> {
  const { to, ownerName, ocName, ocAddress, amount, claimDate, rejectionReason, lotLabel, ocShortCode, companyLogoUrl, ocId } = params;
  const subject = `Update on your payment claim , ${ocName}`;

  const from = await resolveOcSenderFromHeader(ocId ?? null);

  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "my-arrears",
    "Resubmit or view details",
    "Log in to StrataWise to view your outstanding balance and resubmit the claim.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Update on your payment claim</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greeting(ownerName)} after review, the payment claim you submitted for <strong>${escapeHtml(ocAddress)}</strong> has not been matched. The details and the manager's note are below.
    </p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:16px;margin:0 0 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Lot</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(lotLabel)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0E314C;">$${amount.toFixed(2)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Claimed date</p>
      <p style="margin:0;font-size:14px;color:#0E314C;">${escapeHtml(claimDate)}</p>
    </div>
    <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Reason from your strata manager</p>
      <p style="margin:0;font-size:14px;line-height:1.5;color:#0E314C;">${escapeHtml(rejectionReason)}</p>
    </div>
    ${ctaBlock}
  `, companyLogoUrl);

  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    resendFrom: from,
  });
  if (error) {
    console.error("Failed to send claim_rejected email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── PP6-C-2: manager-facing transactional email ─────────────────────────

export interface SendNewClaimSubmittedEmailParams {
  to: string;
  managerName: string | null;
  ocName: string;
  lotLabel: string;
  ownerName: string | null;
  amount: number;
  claimDate: string;
  paymentMethod: string;
  notes: string | null;
  ocShortCode: string;
  companyLogoUrl?: string | null;
  // Optional OC id , when provided, the send routes through the firm's
  // configured mail provider (Gmail send-as) so manager-to-manager
  // notifications land in the firm's domain instead of the brand noreply.
  ocId?: string | null;
}

export async function sendNewClaimSubmittedEmail(
  params: SendNewClaimSubmittedEmailParams,
): Promise<EmailSendResult> {
  const { to, managerName, ocName, lotLabel, ownerName, amount, claimDate, paymentMethod, notes, ocShortCode, companyLogoUrl, ocId } = params;
  const subject = `New owner payment claim , ${ocName} ${lotLabel}`;

  const greetingLine = managerName ? `Hi ${managerName},` : "Hi,";
  const ownerLabel = ownerName ?? "An owner";
  const notesBlock = notes && notes.trim().length > 0
    ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Owner notes</p><p style="margin:0;font-size:14px;line-height:1.5;color:#0E314C;">${escapeHtml(notes)}</p>`
    : "";

  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "reconciliation/claims",
    "Review claim",
    "Log in to StrataWise to review this claim in the reconciliation queue.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">New payment claim</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greetingLine} ${escapeHtml(ownerLabel)} has submitted a payment claim for <strong>${escapeHtml(ocName)}</strong> that needs your review.
    </p>
    <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Lot</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(lotLabel)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0E314C;">$${amount.toFixed(2)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Claimed date</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(claimDate)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Method</p>
      <p style="margin:0;font-size:14px;color:#0E314C;">${escapeHtml(paymentMethod)}</p>
    </div>
    ${notesBlock ? `<div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">${notesBlock}</div>` : ""}
    ${ctaBlock}
    <p style="margin:24px 0 0;color:#4A5868;font-size:12px;line-height:1.5;">
      You're receiving this because you're a strata manager for ${escapeHtml(ocName)}.
    </p>
  `, companyLogoUrl);

  // Goes to managers within the same firm. Falls back to the brand noreply
  // identity when no OC scope is supplied , but with ocId we route via the
  // firm's primary manager mailbox so the notification reads as coming from
  // their own firm (and routes through Gmail when configured).
  const resendFrom = ocId
    ? await resolveOcSenderFromHeader(ocId)
    : systemFrom();
  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    resendFrom,
  });
  if (error) {
    console.error("Failed to send new_claim_submitted email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── Levy CSV reminder (manager-facing) ───────────────────────────────────
// Sent by the daily cron when an OC's levy run is due within 7 days but no
// fresh bank CSV has been imported in the last 7 days, so the manager can
// upload one before the run fires "blind" (arrears computed off stale data).

export interface SendLevyCsvReminderEmailParams {
  to: string;
  managerName: string | null;
  ocName: string;
  ocShortCode: string;
  nextSendDate: string;        // human-readable
  lastImportLabel: string;     // e.g. "never" or a date
  companyLogoUrl?: string | null;
  ocId?: string | null;
}

export async function sendLevyCsvReminderEmail(
  params: SendLevyCsvReminderEmailParams,
): Promise<EmailSendResult> {
  const { to, managerName, ocName, ocShortCode, nextSendDate, lastImportLabel, companyLogoUrl, ocId } = params;
  const subject = `Bank CSV due before the next levy run , ${ocName}`;

  const greetingLine = managerName ? `Hi ${managerName},` : "Hi,";
  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "reconciliation",
    "Upload bank CSV",
    "Log in to StrataWise and import the latest bank CSV before the run.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Upload a bank CSV before the next levy run</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greetingLine} the next levy run for <strong>${escapeHtml(ocName)}</strong> is scheduled for <strong>${escapeHtml(nextSendDate)}</strong>, but we haven't seen a fresh bank CSV recently. Importing one now keeps arrears accurate on the notices.
    </p>
    <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Next levy run</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(nextSendDate)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Last bank CSV imported</p>
      <p style="margin:0;font-size:14px;color:#0E314C;">${escapeHtml(lastImportLabel)}</p>
    </div>
    ${ctaBlock}
    <p style="margin:24px 0 0;color:#4A5868;font-size:12px;line-height:1.5;">
      You can turn these reminders off in Settings , Notifications.
    </p>
  `, companyLogoUrl);

  const resendFrom = ocId ? await resolveOcSenderFromHeader(ocId) : systemFrom();
  const { data, error } = await transportSend({ ocId: ocId ?? null, to, subject, html, resendFrom });
  if (error) {
    console.error("Failed to send levy_csv_reminder email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── Compliance reminder (manager-facing: insurance expiry, AGM due) ───────

export interface SendComplianceReminderEmailParams {
  to: string;
  managerName: string | null;
  heading: string;
  body: string;
  ctaPath?: string | null;   // dashboard path relative to /ocs/{code} or absolute
  ctaShortCode?: string | null;
  ctaLabel?: string;
  companyLogoUrl?: string | null;
  ocId?: string | null;
}

export async function sendComplianceReminderEmail(
  params: SendComplianceReminderEmailParams,
): Promise<EmailSendResult> {
  const { to, managerName, heading, body, ctaPath, ctaShortCode, ctaLabel, companyLogoUrl, ocId } = params;
  const greetingLine = managerName ? `Hi ${escapeHtml(managerName)},` : "Hi,";
  const cta = ctaShortCode && ctaPath
    ? buildCtaBlock(ctaShortCode, ctaPath, ctaLabel ?? "Open StrataWise", body)
    : "";
  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">${escapeHtml(heading)}</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">${greetingLine} ${escapeHtml(body)}</p>
    ${cta}
    <p style="margin:24px 0 0;color:#4A5868;font-size:12px;line-height:1.5;">You can turn these reminders off in Settings , Notifications.</p>
  `, companyLogoUrl);
  const resendFrom = ocId ? await resolveOcSenderFromHeader(ocId) : systemFrom();
  const { data, error } = await transportSend({ ocId: ocId ?? null, to, subject: heading, html, resendFrom });
  if (error) { console.error("Failed to send compliance_reminder email:", error); return { error: error.message }; }
  return { success: true, id: data?.id ?? null };
}

// ─── Meeting notice (owner-facing, branded PDF attached) ───────────────────

export interface SendMeetingNoticeEmailParams {
  to: string;
  ownerName: string | null;
  ocName: string;
  meetingTypeLabel: string;
  meetingTitle: string;
  whenLabel: string;
  location: string | null;
  onlineLink: string | null;
  agenda: Array<{ position: number; title: string }>;
  pdfBuffer: Buffer;
  pdfFilename: string;
  companyLogoUrl?: string | null;
  ocId?: string | null;
}

export async function sendMeetingNoticeEmail(
  params: SendMeetingNoticeEmailParams,
): Promise<EmailSendResult> {
  const { to, ownerName, ocName, meetingTypeLabel, meetingTitle, whenLabel, location, onlineLink, agenda, pdfBuffer, pdfFilename, companyLogoUrl, ocId } = params;
  const subject = `Meeting notice , ${meetingTypeLabel} for ${ocName}`;

  const greetingLine = ownerName ? `Hi ${escapeHtml(ownerName)},` : "Hi,";
  const agendaBlock = agenda.length > 0
    ? `<div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
         <p style="margin:0 0 8px;font-size:13px;color:#4A5868;">Agenda</p>
         <ol style="margin:0;padding-left:18px;color:#0E314C;font-size:14px;line-height:1.7;">
           ${agenda.map((a) => `<li>${escapeHtml(a.title)}</li>`).join("")}
         </ol>
       </div>`
    : "";

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">${escapeHtml(meetingTypeLabel)}</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greetingLine} you're invited to the following meeting for <strong>${escapeHtml(ocName)}</strong>. The full notice is attached.
    </p>
    <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 16px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Meeting</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(meetingTitle)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">When</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(whenLabel)}</p>
      ${location ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Where</p><p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(location)}</p>` : ""}
      ${onlineLink ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Online</p><p style="margin:0;font-size:14px;color:#0E314C;"><a href="${escapeHtml(onlineLink)}" style="color:#0E314C;">${escapeHtml(onlineLink)}</a></p>` : ""}
    </div>
    ${agendaBlock}
  `, companyLogoUrl);

  const resendFrom = ocId ? await resolveOcSenderFromHeader(ocId) : systemFrom();
  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    resendFrom,
    attachments: [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }],
  });
  if (error) {
    console.error("Failed to send meeting_notice email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── Maintenance reminder (owner-facing) ───────────────────────────────────

export interface SendMaintenanceReminderEmailParams {
  to: string;
  ownerName: string | null;
  ocName: string;
  jobTitle: string;
  occurrenceLabel: string;
  contractorName: string | null;
  scope: string | null;
  companyLogoUrl?: string | null;
  ocId?: string | null;
}

export async function sendMaintenanceReminderEmail(
  params: SendMaintenanceReminderEmailParams,
): Promise<EmailSendResult> {
  const { to, ownerName, ocName, jobTitle, occurrenceLabel, contractorName, scope, companyLogoUrl, ocId } = params;
  const subject = `Upcoming maintenance , ${jobTitle} at ${ocName}`;

  const greetingLine = ownerName ? `Hi ${escapeHtml(ownerName)},` : "Hi,";
  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#0E314C;">Upcoming maintenance</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greetingLine} scheduled maintenance is coming up at <strong>${escapeHtml(ocName)}</strong>.
    </p>
    <div style="background:#FAF7F0;border:1px solid #E5E0D3;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Job</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(jobTitle)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Scheduled for</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(occurrenceLabel)}</p>
      ${contractorName ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Contractor</p><p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(contractorName)}</p>` : ""}
      ${scope ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Details</p><p style="margin:0;font-size:14px;color:#0E314C;line-height:1.5;">${escapeHtml(scope)}</p>` : ""}
    </div>
  `, companyLogoUrl);

  const resendFrom = ocId ? await resolveOcSenderFromHeader(ocId) : systemFrom();
  const { data, error } = await transportSend({ ocId: ocId ?? null, to, subject, html, resendFrom });
  if (error) {
    console.error("Failed to send maintenance_update email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── Levy follow-up / escalation email ─────────────────────────────────────
// Sent by the daily follow-up cron. The subject + body are manager-authored
// (merge fields already substituted by the caller); we just wrap the body in
// the brand shell and optionally attach the final-notice PDF.

export interface SendEscalationEmailParams {
  to: string;
  subject: string;
  bodyText: string;            // plain text, already merge-rendered
  companyLogoUrl?: string | null;
  ocId?: string | null;
  pdfBuffer?: Buffer | null;
  pdfFilename?: string | null;
  extraAttachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}

export async function sendEscalationEmail(
  params: SendEscalationEmailParams,
): Promise<EmailSendResult> {
  const { to, subject, bodyText, companyLogoUrl, ocId, pdfBuffer, pdfFilename, extraAttachments } = params;

  const paragraphs = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;color:#0E314C;font-size:14px;line-height:1.6;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  const html = brandShell(paragraphs, companyLogoUrl);

  const resendFrom = ocId ? await resolveOcSenderFromHeader(ocId) : systemFrom();
  const attachments = [
    ...(pdfBuffer && pdfFilename ? [{ filename: pdfFilename, content: pdfBuffer, contentType: "application/pdf" }] : []),
    ...(extraAttachments ?? []),
  ];
  const { data, error } = await transportSend({ ocId: ocId ?? null, to, subject, html, resendFrom, attachments: attachments.length ? attachments : undefined });
  if (error) {
    console.error("Failed to send levy_followup email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── HTML escape helper ────────────────────────────────────────────────
// Applied to user-controlled string interpolations in the new senders to
// guard against accidental injection from owner names, oc
// addresses, or rejection-reason free text.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ─── CTA hyperlink helper (PP6.5) ─────────────────────────────────────
// Builds an HTML CTA block to a dashboard path. Falls back to a plain-
// text instruction when NEXT_PUBLIC_APP_URL is unset (avoids broken
// anchors with relative hrefs in inline-HTML mail clients).
function buildCtaBlock(
  ocShortCode: string,
  path: string,
  ctaLabel: string,
  fallbackText: string,
): string {
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  if (!appBaseUrl) {
    return `<p style="margin:0 0 24px;color:#0E314C;font-size:14px;">${escapeHtml(fallbackText)}</p>`;
  }
  return `<a href="${appBaseUrl}/ocs/${escapeHtml(ocShortCode)}/${path}" style="display:inline-block;background:#CFA753;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:10px 24px;border-radius:6px;margin:0 0 24px;">
    ${escapeHtml(ctaLabel)}
  </a>`;
}

// ─── PP6.5: escalation step senders ────────────────────────────────────
// Step 2 (second reminder; 28+ days overdue; opt-out-able via
// notification_preferences.notification_type='second_reminder') and
// step 3 (final notice; mandatory; bypasses opt-out via
// MANDATORY_NOTIFICATION_TYPES = { 'levy_final_notice' }).

export interface SendSecondReminderEmailParams extends SharedSenderHeader {
  referenceNumber: string;
  amountOutstanding: number;
  daysOverdue: number;
  dueDate: string;
  penaltyInterestAccrued: number;
  ocShortCode: string;
  pdfBuffer?: Buffer | null;
  pdfFilename?: string;
}

export async function sendSecondReminderEmail(
  params: SendSecondReminderEmailParams,
): Promise<EmailSendResult> {
  const {
    to, ownerName, ocName, ocAddress,
    referenceNumber, amountOutstanding, daysOverdue, dueDate,
    penaltyInterestAccrued, ocShortCode, companyLogoUrl,
    pdfBuffer, pdfFilename, ocId,
  } = params;
  const subject = `Second reminder , levy overdue ${daysOverdue}+ days , ${ocName}`;

  const interestLine = penaltyInterestAccrued > 0
    ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Interest accrued</p><p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#dc2626;">$${penaltyInterestAccrued.toFixed(2)}</p>`
    : "";

  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "my-arrears",
    "View outstanding balance",
    "Log in to StrataWise to view your outstanding balance and payment options.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:600;color:#b45309;">Second reminder , levy ${daysOverdue}+ days overdue</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greeting(ownerName)} our records still show an unpaid levy at <strong>${escapeHtml(ocAddress)}</strong>. It is now more than <strong>${daysOverdue} days</strong> overdue and penalty interest is accruing.
    </p>
    <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Reference</p>
      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#0E314C;">${escapeHtml(referenceNumber)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Original due date</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(dueDate)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount outstanding</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#0E314C;">$${amountOutstanding.toFixed(2)}</p>
      ${interestLine}
    </div>
    ${ctaBlock}
    <p style="margin:0;color:#4A5868;font-size:12px;line-height:1.5;">
      If payment is not received, the matter may proceed to a final notice and further recovery action under your strata rules.
    </p>
  `, companyLogoUrl);

  const from = await resolveOcSenderFromHeader(ocId ?? null);

  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    attachments: pdfBuffer
      ? [
          {
            filename: pdfFilename ?? `${referenceNumber}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ]
      : undefined,
    resendFrom: from,
  });
  if (error) {
    console.error("Failed to send second_reminder email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

export interface SendFinalNoticeEmailParams extends SharedSenderHeader {
  referenceNumber: string;
  amountOutstanding: number;
  daysOverdue: number;
  dueDate: string;
  penaltyInterestAccrued: number;
  ocShortCode: string;
  // Final notice attaches a MERGED PDF: cover page (rendered via
  // sendFinalNoticeEmail's caller) + original levy notice. Caller builds
  // the merged buffer via src/lib/pdf/merge.ts.
  pdfBuffer?: Buffer | null;
  pdfFilename?: string;
}

export async function sendFinalNoticeEmail(
  params: SendFinalNoticeEmailParams,
): Promise<EmailSendResult> {
  const {
    to, ownerName, ocName, ocAddress,
    referenceNumber, amountOutstanding, daysOverdue, dueDate,
    penaltyInterestAccrued, ocShortCode, companyLogoUrl,
    pdfBuffer, pdfFilename, ocId,
  } = params;
  const subject = `FINAL NOTICE , outstanding levy , ${ocName}`;

  const interestLine = penaltyInterestAccrued > 0
    ? `<p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Interest accrued</p><p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#dc2626;">$${penaltyInterestAccrued.toFixed(2)}</p>`
    : "";

  const ctaBlock = buildCtaBlock(
    ocShortCode,
    "my-arrears",
    "View outstanding balance",
    "Log in to StrataWise to view your outstanding balance and pay the levy immediately.",
  );

  const html = brandShell(`
    <h2 style="margin:0 0 16px;font-size:20px;font-weight:700;color:#b91c1c;">FINAL NOTICE , levy outstanding</h2>
    <p style="margin:0 0 20px;color:#0E314C;font-size:14px;line-height:1.6;">
      ${greeting(ownerName)} this is a <strong>final notice</strong> for the unpaid levy at <strong>${escapeHtml(ocAddress)}</strong>. The levy is now more than <strong>${daysOverdue} days</strong> overdue.
    </p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Reference</p>
      <p style="margin:0 0 12px;font-size:14px;font-weight:600;color:#0E314C;">${escapeHtml(referenceNumber)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Original due date</p>
      <p style="margin:0 0 12px;font-size:14px;color:#0E314C;">${escapeHtml(dueDate)}</p>
      <p style="margin:0 0 4px;font-size:13px;color:#4A5868;">Amount outstanding</p>
      <p style="margin:0 0 12px;font-size:18px;font-weight:700;color:#b91c1c;">$${amountOutstanding.toFixed(2)}</p>
      ${interestLine}
    </div>
    ${ctaBlock}
    <p style="margin:0 0 8px;color:#0E314C;font-size:14px;line-height:1.5;">
      If full payment is not received promptly, the owners' corporation may commence recovery action , including, where appropriate, an application to VCAT or referral to a debt-recovery agent. Costs of recovery may be added to the debt under section 32 of the Owners Corporations Act 2006 (Vic).
    </p>
    <p style="margin:0;color:#4A5868;font-size:12px;line-height:1.5;">
      This notice is sent as a statutory communication and cannot be opted out of.
    </p>
  `, companyLogoUrl);

  const from = await resolveOcSenderFromHeader(ocId ?? null);

  const { data, error } = await transportSend({
    ocId: ocId ?? null,
    to,
    subject,
    html,
    attachments: pdfBuffer
      ? [
          {
            filename: pdfFilename ?? `final-notice-${referenceNumber}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
          },
        ]
      : undefined,
    resendFrom: from,
  });
  if (error) {
    console.error("Failed to send levy_final_notice email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── Manager-initiated message (Communications tab "Send email") ──
// Plain-text body wrapped in the brand shell. FROM resolves to the manager's
// own "Name - Company <username@brand-domain>" identity. Falls back to the
// brand noreply when the manager hasn't picked a username yet.
export async function sendManagerMessageEmail(params: {
  managerProfileId: string;
  to: string;
  subject: string;
  bodyText: string;
  ocName?: string | null;
  companyLogoUrl?: string | null;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
}): Promise<EmailSendResult> {
  const { managerProfileId, to, subject, bodyText, companyLogoUrl, attachments } = params;

  // Dispatch based on the manager's company mail_provider:
  //   stratawise → Resend transport, FROM <username>@stratawise.com.au
  //   gmail      → Gmail API via DWD impersonation (real transport below)
  const dispatch = await resolveDispatchProvider(managerProfileId);

  const htmlBodyEscaped = escapeHtml(bodyText).replace(/\r?\n/g, "<br />");
  const html = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:600px;margin:0;padding:0;color:#0E314C;font-size:14px;line-height:1.6;text-align:left;">
      ${htmlBodyEscaped}
    </div>
  `;
  void companyLogoUrl;

  // Gmail send-as. Requires the platform's service account JSON + the
  // customer Workspace admin to have authorised our Client ID against
  // GMAIL_SCOPES. Falls back to Resend on retryable failures (rate limit
  // after one retry) , fatal failures (unauthorized_client, forbidden)
  // surface to the caller so the manager sees a real error and can fix
  // their DWD grant from /settings → Email.
  if (dispatch.provider === "gmail" && isGmailConfigured()) {
    const senderEmail = await resolveManagerSenderEmail(
      managerProfileId,
      dispatch.domain,
    );
    if (senderEmail) {
      const displayName = await resolveManagerDisplayName(managerProfileId);
      const result = await sendViaGmail({
        managerEmail: senderEmail,
        to,
        subject,
        htmlBody: html,
        fromDisplayName: displayName,
        attachments,
      });
      if (result.ok) {
        // We store Gmail's RFC822 Message-ID as external_id (NOT the
        // internal Gmail id), so the inbound webhook can match replies'
        // In-Reply-To headers exactly the same way as Resend.
        return {
          success: true,
          id: result.rfc822MessageId || result.messageId,
        };
      }
      if (!result.retryable) {
        console.error(
          "[email] Gmail send failed for",
          senderEmail,
          ":",
          result.error,
        );
        return { error: result.error };
      }
      console.warn(
        "[email] Gmail rate-limited after retry, falling back to Resend for this send.",
      );
    } else {
      console.warn(
        "[email] mail_provider=gmail but couldn't resolve a sender mailbox under domain",
        dispatch.domain,
        ", falling back to Resend.",
      );
    }
  }

  const from =
    (await resolveManagerFromHeader(managerProfileId)) ??
    orgNoreplyFrom(await resolveManagerCompanyName(managerProfileId));

  // Plain, left-aligned email body. We escape HTML to neutralise injection
  // from owner-typed content, then convert newlines to <br/> so every
  // email client (Gmail, Outlook, Apple Mail) preserves the manager's
  // line breaks. `html` is already built above so the Gmail branch can
  // reuse it; falling through here means we're sending via Resend.
  const { data, error } = await getResend().emails.send({
    from,
    to,
    subject,
    html,
    ...(attachments && attachments.length > 0
      ? { attachments }
      : {}),
  });
  if (error) {
    console.error("Failed to send manager_message email:", error);
    return { error: error.message };
  }
  return { success: true, id: data?.id ?? null };
}

// ─── Mail provider dispatch helper ─────────────────────────────────────
// Resolves which transport to use for a given manager. Per-firm via
// management_companies.mail_provider. Falls back to stratawise on lookup
// failure so outbound mail never silently breaks.
interface MailDispatch {
  provider: "stratawise" | "gmail";
  companyId: string | null;
  domain: string | null;
}

// For a Gmail-routed send, the FROM mailbox MUST be a real Workspace mailbox
// the admin has authorised our service account against. The only mailbox we
// KNOW is valid is whatever they tested under Settings → Email (which we
// stored on gmail_mailbox_subscriptions). The manager's profile.email is
// usually their personal address (e.g. an outlook.com / gmail.com signup)
// and synthesising `<email_username>@<firm-domain>` produced invalid_grant
// because that mailbox didn't exist in Workspace.
//
// Resolution order:
//   1. gmail_mailbox_subscriptions row keyed by manager_profile_id
//      (the mailbox THIS manager confirmed during test-connection).
//   2. Any subscription for the same management_company (a manager whose
//      personal profile email isn't on the firm domain but whose firm
//      has at least one verified mailbox , we send from that).
//   3. profile.email if its domain matches firm-domain.
//   4. null → caller falls back to Resend.
async function resolveManagerSenderEmail(
  managerProfileId: string,
  firmDomain: string | null,
): Promise<string | null> {
  if (!firmDomain) return null;
  try {
    const supabase = createServerClient();
    const { data: profileRow } = await supabase
      .from("profiles")
      .select("email, management_company_id")
      .eq("id", managerProfileId)
      .maybeSingle();
    const profile = (profileRow as {
      email: string | null;
      management_company_id: string | null;
    } | null) ?? null;

    // (1) per-manager confirmed mailbox.
    const { data: own } = await supabase
      .from("gmail_mailbox_subscriptions")
      .select("mailbox_email")
      .eq("manager_profile_id", managerProfileId)
      .maybeSingle();
    const ownMailbox = (own as { mailbox_email: string | null } | null)
      ?.mailbox_email;
    if (ownMailbox) return ownMailbox.toLowerCase().trim();

    // (2) any verified mailbox in the firm.
    if (profile?.management_company_id) {
      const { data: firmRow } = await supabase
        .from("gmail_mailbox_subscriptions")
        .select("mailbox_email")
        .eq("management_company_id", profile.management_company_id)
        .limit(1)
        .maybeSingle();
      const firmMailbox = (firmRow as { mailbox_email: string | null } | null)
        ?.mailbox_email;
      if (firmMailbox) return firmMailbox.toLowerCase().trim();
    }

    // (3) profile email on the firm domain.
    const emailDomain = profile?.email?.split("@")[1]?.toLowerCase() ?? "";
    if (profile?.email && emailDomain === firmDomain.toLowerCase()) {
      return profile.email.toLowerCase().trim();
    }

    return null;
  } catch (err) {
    console.error("[email] resolveManagerSenderEmail failed:", err);
    return null;
  }
}

async function resolveManagerDisplayName(
  managerProfileId: string,
): Promise<string | undefined> {
  try {
    const supabase = createServerClient();
    const { data } = await supabase
      .from("profiles")
      .select("first_name, last_name, management_company_id")
      .eq("id", managerProfileId)
      .maybeSingle();
    if (!data) return undefined;
    const person = [data.first_name, data.last_name].filter(Boolean).join(" ");
    let company: string | null = null;
    if (data.management_company_id) {
      const { data: companyRow } = await supabase
        .from("management_companies")
        .select("name")
        .eq("id", data.management_company_id)
        .maybeSingle();
      company = (companyRow as { name: string | null } | null)?.name ?? null;
    }
    if (person && company) return `${person} - ${company}`;
    if (person) return person;
    if (company) return company;
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveDispatchProvider(
  managerProfileId: string,
): Promise<MailDispatch> {
  try {
    const supabase = createServerClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("management_company_id")
      .eq("id", managerProfileId)
      .maybeSingle();
    const companyId =
      (profile as { management_company_id: string | null } | null)
        ?.management_company_id ?? null;
    if (!companyId) {
      return { provider: "stratawise", companyId: null, domain: null };
    }
    const { data: company } = await supabase
      .from("management_companies")
      .select("mail_provider, mail_provider_config")
      .eq("id", companyId)
      .maybeSingle();
    const row = company as {
      mail_provider: "stratawise" | "gmail" | null;
      mail_provider_config: { domain?: string } | null;
    } | null;
    return {
      provider: row?.mail_provider ?? "stratawise",
      companyId,
      domain: row?.mail_provider_config?.domain ?? null,
    };
  } catch (err) {
    console.error("[email] resolveDispatchProvider failed:", err);
    return { provider: "stratawise", companyId: null, domain: null };
  }
}
