import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Inbound email auto-link by sender → lot owner email.
//
// When a cold inbound email arrives that didn't match by In-Reply-To
// header or by recent-outbound-thread, this helper looks up whether the
// sender email is the registered email of exactly one lot owner across
// the manager's portfolio. If so, we link the communication_log row to
// that owner's lot , same effect as the manager clicking the "Link to
// lot" dropdown manually.
//
// Rules (deliberately conservative to avoid false positives):
//   - Exact case-insensitive email match against lot_owners.email
//   - Owner must be active (left_at IS NULL)
//   - Owner must belong to an OC managed by the manager's company
//   - Must be EXACTLY ONE match. Multiple matches (same email on two
//     lots, e.g. spouse owns both) stay unlinked and surface in the
//     unrouted queue with the candidates for the manager to pick.
//
// UI never says "auto-linked" , the resulting row looks identical to a
// manager-link. The audit_log entry records `action: "auto_link_by_sender_email"`
// for traceability.

export type AutoLinkResult =
  | { kind: "none" }
  | { kind: "ambiguous"; candidateLotOwnerIds: string[] }
  | {
      kind: "matched";
      ocId: string;
      lotId: string;
      lotOwnerId: string;
    };

export async function autoLinkBySenderEmail(
  supabase: SupabaseClient,
  args: { senderEmail: string; managerProfileId: string },
): Promise<AutoLinkResult> {
  const email = args.senderEmail.trim().toLowerCase();
  if (!email) return { kind: "none" };

  // Step 1: resolve the manager's company. We constrain owners by
  // owner→lot→oc→management_company_id so we don't accidentally link to
  // a homonym email on another firm's books.
  const { data: profile } = await supabase
    .from("profiles")
    .select("management_company_id")
    .eq("id", args.managerProfileId)
    .maybeSingle();
  const companyId = (profile as { management_company_id?: string | null } | null)
    ?.management_company_id ?? null;
  if (!companyId) return { kind: "none" };

  // Step 2: find lot owners with this email under that company's OCs.
  // Join via the inner select on lots → owners_corporations so RLS /
  // direct filtering both work.
  const { data: matches } = await supabase
    .from("lot_owners")
    .select(
      "id, lot_id, oc_id, lots!inner(id, oc_id, owners_corporations!inner(management_company_id))",
    )
    .ilike("email", email)
    .is("left_at", null)
    .eq("lots.owners_corporations.management_company_id", companyId);

  const rows = (matches ?? []) as Array<{
    id: string;
    lot_id: string;
    oc_id: string;
  }>;
  if (rows.length === 0) return { kind: "none" };
  if (rows.length > 1) {
    return {
      kind: "ambiguous",
      candidateLotOwnerIds: rows.map((r) => r.id),
    };
  }
  const m = rows[0];
  return {
    kind: "matched",
    ocId: m.oc_id,
    lotId: m.lot_id,
    lotOwnerId: m.id,
  };
}

// Side-effect helper: applies the matched result onto an already-created
// communication_log row, and audits the auto-link. Caller decides whether
// to run it (e.g. only when the upstream thread-match cascade returned
// nothing).
export async function applyAutoLinkToCommLog(
  supabase: SupabaseClient,
  args: {
    communicationLogId: string;
    senderEmail: string;
    managerProfileId: string;
    sourceChannel: "gmail" | "resend";
  },
): Promise<AutoLinkResult> {
  const result = await autoLinkBySenderEmail(supabase, {
    senderEmail: args.senderEmail,
    managerProfileId: args.managerProfileId,
  });
  if (result.kind !== "matched") return result;

  await supabase
    .from("communication_log")
    .update({
      oc_id: result.ocId,
      lot_id: result.lotId,
      lot_owner_id_at_creation: result.lotOwnerId,
    })
    .eq("id", args.communicationLogId);

  await supabase.from("audit_log").insert({
    profile_id: args.managerProfileId,
    oc_id: result.ocId,
    action: "auto_link_by_sender_email",
    entity_type: "communication_log",
    entity_id: args.communicationLogId,
    metadata: {
      sender_email: args.senderEmail,
      lot_id: result.lotId,
      lot_owner_id: result.lotOwnerId,
      source_channel: args.sourceChannel,
    },
  });

  return result;
}
