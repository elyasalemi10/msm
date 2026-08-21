"use server";

import { requireCompanyRole, getCurrentProfile } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { sendInvitationEmail } from "@/lib/email";
import { resolveCompanyLogo } from "@/lib/notifications";
// canonicaliseSender / sweepMappingsForOwnerChange were part of the
// nuked reconciliation stack; the owner-change sweep was a bank-payer
// mapping update. New flow will rebuild this if needed.
import { buildOCUrl } from "@/lib/oc-resolver";
import { generateInviteCode, normaliseInviteCode } from "@/lib/invite-code";
import { rateLimitCheck, getClientIp } from "@/lib/rate-limit";
import { headers } from "next/headers";

export async function inviteStrataManager(data: { email: string; name: string }) {
  const profile = await requireCompanyRole();

  if (!profile.management_company_id) {
    return { error: "No management company found" };
  }

  const supabase = createServerClient();

  // Check for existing pending invitation
  const { data: existing } = await supabase
    .from("invitations")
    .select("id")
    .eq("email", data.email)
    .eq("role", "strata_manager")
    .eq("status", "pending")
    .single();

  if (existing) {
    return { error: "A pending invitation already exists for this email" };
  }

  // Need a oc_id for the FK , use any active oc from the company
  const { data: anySub } = await supabase
    .from("owners_corporations")
    .select("id")
    .eq("management_company_id", profile.management_company_id)
    .eq("status", "active")
    .limit(1)
    .single();

  if (!anySub) {
    return { error: "Create at least one oc before inviting team members" };
  }

  const { data: invitation, error } = await supabase
    .from("invitations")
    .insert({
      oc_id: anySub.id,
      email: data.email,
      name: data.name,
      role: "strata_manager",
      invited_by: profile.id,
      code: generateInviteCode(),
    })
    .select("id, code")
    .single();

  if (error) return { error: error.message };

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    action: "create",
    entity_type: "invitation",
    entity_id: invitation.id,
    after_state: { email: data.email, name: data.name, role: "strata_manager" },
  });

  // Send invitation email
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "") || "http://localhost:3002";
  const inviteUrl = `${baseUrl}/invite/${invitation.code}`;
  const companyLogoUrl = await resolveCompanyLogo(supabase, {
    managementCompanyId: profile.management_company_id,
  });
  await sendInvitationEmail({
    to: data.email,
    inviteeName: data.name,
    role: "strata_manager",
    ocName: "Your management company",
    ocAddress: "",
    inviteUrl,
    companyLogoUrl,
    inviterProfileId: profile.id,
  });

  return { success: true, code: invitation.code };
}

/**
 * Look up an invitation by its 10-char code. Rate-limited by client IP to
 * defuse brute-force enumeration: max 10 lookups per IP per 10 minutes.
 *
 * Returns null when the code is unknown OR the IP is rate-limited , we
 * deliberately don't distinguish the two so an attacker can't tell whether
 * a code shape is valid by watching response codes.
 */
export async function getInvitationByCode(rawCode: string) {
  const code = normaliseInviteCode(rawCode);
  if (!code) return null;

  const h = await headers();
  const ip = getClientIp(h);
  const rl = await rateLimitCheck({
    key: `invite_lookup:${ip}`,
    limit: 10,
    windowMs: 10 * 60 * 1000,
  });
  if (!rl.ok) return null;

  const supabase = createServerClient();

  const { data: invitation } = await supabase
    .from("invitations")
    .select(`
      *,
      ocs:oc_id (id, name, address, plan_number),
      lots:lot_id (lot_number, unit_number)
    `)
    .eq("code", code)
    .single();

  if (!invitation) return null;

  return {
    ...invitation,
    oc: invitation.ocs,
    lot: invitation.lots,
    isExpired: new Date(invitation.expires_at) < new Date(),
  };
}

export async function acceptInvitation(rawCode: string) {
  // Item 19 , email decoupling. Invitation lookup is by `code` ONLY; we do
  // NOT require profile.email to match invitation.email. The same person can
  // legitimately be on multiple OCs under different contact emails, but want
  // to manage them all from a single platform login. The `lot_owners.email`
  // column (OC-facing contact) stays untouched by this flow; only the
  // entity-model `owners.profile_id` gets linked. Updates to lot_owners.email
  // are blocked once status='accepted' (see updateLotOwnerContact in
  // src/lib/actions/lot-edit.ts) , the owner then changes their contact
  // email from the portal themselves.
  const code = normaliseInviteCode(rawCode);
  if (!code) return { error: "Invalid invite code" };

  const profile = await getCurrentProfile();
  if (!profile) return { error: "Please sign in first" };

  const supabase = createServerClient();

  // Fetch invitation
  const { data: invitation } = await supabase
    .from("invitations")
    .select("*")
    .eq("code", code)
    .single();

  if (!invitation) return { error: "Invitation not found" };
  if (invitation.status === "accepted") return { error: "This invitation has already been accepted" };
  if (invitation.status === "revoked") return { error: "This invitation has been revoked" };
  if (new Date(invitation.expires_at) < new Date()) return { error: "This invitation has expired" };

  // Check lot isn't already claimed (for lot_owner invitations)
  if (invitation.lot_id) {
    const { data: existingMember } = await supabase
      .from("oc_members")
      .select("id")
      .eq("lot_id", invitation.lot_id)
      .eq("role", "lot_owner")
      .is("left_at", null)
      .single();

    if (existingMember) {
      return { error: "This lot has already been claimed by another owner" };
    }
  }

  // Update invitation status
  await supabase
    .from("invitations")
    .update({ status: "accepted" })
    .eq("id", invitation.id);

  if (invitation.role === "strata_manager") {
    // Get the management company from the oc
    const { data: sub } = await supabase
      .from("owners_corporations")
      .select("management_company_id")
      .eq("id", invitation.oc_id)
      .single();

    if (sub) {
      // Assign to management company. Invited managers default to
      // 'manager' company_role (can do day-to-day ops, cannot invite
      // others or modify team). An admin can promote them later.
      await supabase
        .from("profiles")
        .update({
          role: "strata_manager",
          management_company_id: sub.management_company_id,
          company_role: "manager",
        })
        .eq("id", profile.id);
    }
  } else {
    // Lot owner , create oc member
    await supabase
      .from("profiles")
      .update({ role: "lot_owner" })
      .eq("id", profile.id);

    await supabase.from("oc_members").insert({
      oc_id: invitation.oc_id,
      profile_id: profile.id,
      lot_id: invitation.lot_id,
      role: "lot_owner",
      is_primary_contact: true,
    });

    // ─── Entity-model link: connect the new profile to the owner row ─
    //
    // The active lot_ownership for this lot points at an `owners` row
    // (created either via the wizard or applySettlementToLot). On accept,
    // we attach this profile to that owner so future reads
    // (getLotOwners, getLotOwnershipHistory) flip the owner_status to
    // "member" without losing the email / contact / history we already
    // captured. If no entity row exists yet (legacy OC pre-migration),
    // we mint owner + lot_ownership rows fresh so the new tables are
    // populated from this point forward.
    if (invitation.lot_id) {
      try {
        // Find the OC's management_company_id (needed to scope the owners row).
        const { data: ocRow } = await supabase
          .from("owners_corporations")
          .select("management_company_id")
          .eq("id", invitation.oc_id)
          .maybeSingle();
        const managementCompanyId = ocRow?.management_company_id;

        const { data: activeOwnership } = await supabase
          .from("lot_ownerships")
          .select("id, owner_id")
          .eq("lot_id", invitation.lot_id)
          .is("end_date", null)
          .maybeSingle();

        if (activeOwnership) {
          await supabase
            .from("owners")
            .update({ profile_id: profile.id })
            .eq("id", activeOwnership.owner_id);
        } else if (managementCompanyId) {
          // Legacy OC , no owner / lot_ownership yet. Create both.
          const acceptDate = new Date().toISOString().slice(0, 10);
          const { data: createdOwner } = await supabase
            .from("owners")
            .insert({
              management_company_id: managementCompanyId,
              owner_type: "individual",
              name: invitation.name || [profile.first_name, profile.last_name].filter(Boolean).join(" ").trim() || invitation.email,
              email: invitation.email ?? profile.email ?? null,
              phone: invitation.phone ?? null,
              profile_id: profile.id,
            })
            .select("id")
            .single();
          if (createdOwner) {
            await supabase.from("lot_ownerships").insert({
              lot_id: invitation.lot_id,
              owner_id: createdOwner.id,
              oc_id: invitation.oc_id,
              start_date: acceptDate,
              is_primary_contact: true,
              is_financial: true,
            });
          }
        }
      } catch (err) {
        // Entity-model writes are non-fatal , the legacy oc_member row
        // above is enough for the existing read paths.
        console.error("acceptInvitation: entity-model link failed (non-fatal)", err);
      }
    }

    // PP4-B: sweep bank_payer_mappings for active mappings on OTHER lots
    // sharing this owner's canonicalised name. Only flips active→ambiguous
    // (Addition 2: never auto-promotes). Owner name resolved from the
    // profile (preferred) with the invitation's `name` field as fallback
    // for owners whose Supabase Auth profile lacks first/last names.
    if (invitation.lot_id) {
      const fromProfile = [profile.first_name, profile.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      const ownerNameRaw =
        fromProfile.length > 0 ? fromProfile : (invitation.name ?? "").trim();
      // Mapping sweep removed with the reconciliation nuke.
      void ownerNameRaw;
    }
  }

  // Audit
  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: invitation.oc_id,
    action: "accept",
    entity_type: "invitation",
    entity_id: invitation.id,
    after_state: { role: invitation.role, lot_id: invitation.lot_id },
  });

  // Resolve the short_code so the client can redirect to the code-shaped URL.
  const ocUrl = await buildOCUrl(invitation.oc_id, "");

  return {
    success: true,
    ocId: invitation.oc_id,
    ocUrl: ocUrl ?? "/dashboard",
    role: invitation.role,
  };
}
