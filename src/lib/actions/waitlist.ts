"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { Resend } from "resend";
import { createServerClient } from "@/lib/supabase";
import { brandDomain } from "@/lib/manager-username";

const waitlistSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, "Enter your email address.")
    .max(254, "Email is too long.")
    .email("Enter a valid email address."),
  name: z.string().trim().max(120).optional().or(z.literal("")),
  company: z.string().trim().max(160).optional().or(z.literal("")),
  role: z.string().trim().max(60).optional().or(z.literal("")),
});

export type WaitlistFormValues = z.infer<typeof waitlistSchema>;

export type WaitlistResult =
  | { success: true; alreadyOnList: boolean }
  | { success: false; error: string };

const FROM_SYSTEM = `StrataWise <noreply@${brandDomain()}>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function joinWaitlist(input: unknown): Promise<WaitlistResult> {
  const parsed = waitlistSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Invalid submission.";
    return { success: false, error: first };
  }

  const email = parsed.data.email.toLowerCase();
  const name = parsed.data.name?.trim() || null;
  const company = parsed.data.company?.trim() || null;
  const role = parsed.data.role?.trim() || null;

  const headerList = await headers();
  const ipAddress =
    headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headerList.get("x-real-ip") ||
    null;
  const userAgent = headerList.get("user-agent") || null;

  const supabase = createServerClient();

  const { data: existing, error: lookupError } = await supabase
    .from("waitlist_signups")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (lookupError) {
    console.error("[waitlist] lookup failed:", lookupError);
    return { success: false, error: "Something went wrong , please try again." };
  }

  if (existing) {
    return { success: true, alreadyOnList: true };
  }

  const { error: insertError } = await supabase.from("waitlist_signups").insert({
    email,
    name,
    company,
    role,
    source: "landing",
    ip_address: ipAddress,
    user_agent: userAgent,
  });

  if (insertError) {
    console.error("[waitlist] insert failed:", insertError);
    return { success: false, error: "Something went wrong , please try again." };
  }

  await sendOperatorNotification({ email, name, company, role, ipAddress, userAgent });

  return { success: true, alreadyOnList: false };
}

async function sendOperatorNotification(args: {
  email: string;
  name: string | null;
  company: string | null;
  role: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}) {
  const sendTo = process.env.SEND_TO?.trim();
  if (!sendTo) {
    console.warn("[waitlist] SEND_TO not configured , skipping operator notification");
    return;
  }

  const rows: Array<[string, string | null]> = [
    ["Email", args.email],
    ["Name", args.name],
    ["Company", args.company],
    ["Role", args.role],
    ["IP", args.ipAddress],
    ["User agent", args.userAgent],
    ["Submitted", new Date().toISOString()],
  ];

  const html = `
    <div style="font-family:'Inter',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px 0;">
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#0E314C;">New waitlist signup</h2>
      <table style="border-collapse:collapse;font-size:14px;color:#0E314C;">
        ${rows
          .map(
            ([label, value]) => `
              <tr>
                <td style="padding:4px 12px 4px 0;color:#4A5868;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:4px 0;">${value ? escapeHtml(value) : '<span style="color:#9ca3af;">,</span>'}</td>
              </tr>
            `,
          )
          .join("")}
      </table>
    </div>
  `;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: FROM_SYSTEM,
      to: sendTo,
      subject: `New waitlist signup , ${args.email}`,
      html,
      replyTo: args.email,
    });
    if (error) {
      console.error("[waitlist] operator email send failed:", error);
    }
  } catch (err) {
    console.error("[waitlist] operator email threw:", err);
  }
}
