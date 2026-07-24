"use server";

import { requireCompanyRole, requireOCAccess } from "@/lib/auth";
import { createServerClient } from "@/lib/supabase";
import { revalidatePath } from "next/cache";
import { autoMatchBankTransactions } from "@/lib/banking/auto-match";

/**
 * Persist a batch of parsed CSV rows as bank_transactions, then run the
 * two-strategy auto-matcher (DRN → owner reference) on every newly-inserted
 * credit-direction row. Imports themselves stay append-only (no dedup) —
 * managers re-upload whenever they want a fresh snapshot. Auto-matched rows
 * land at match_status='auto_matched'; everything else stays 'unmatched' and
 * surfaces on the reconciliation queue.
 */
export async function importBankTransactions(
  ocId: string,
  accountId: string,
  rows: Array<{
    date: string | null;
    description: string;
    amount: number | null;
    balance: number | null;
    reference: string | null;
  }>,
): Promise<{ inserted?: number; auto_matched?: number; error?: string }> {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: account } = await supabase
    .from("bank_accounts")
    .select("id")
    .eq("id", accountId)
    .eq("oc_id", ocId)
    .maybeSingle();
  if (!account) return { error: "Bank account not found." };

  const inserts = rows.map((r) => ({
    oc_id: ocId,
    bank_account_id: accountId,
    source: "csv_import" as const,
    transaction_date: r.date,
    description: (r.description ?? "").slice(0, 1000),
    amount: r.amount,
    balance: r.balance,
    deft_reference_number: r.reference ? r.reference.slice(0, 64) : null,
    imported_by: profile.id,
  }));

  let insertedIds: string[] = [];
  if (inserts.length > 0) {
    const { data, error } = await supabase
      .from("bank_transactions")
      .insert(inserts)
      .select("id");
    if (error) return { error: error.message };
    insertedIds = (data ?? []).map((r) => r.id as string);
  }

  let autoMatched = 0;
  if (insertedIds.length > 0) {
    // Auto-match is best-effort: the underlying RPC depends on tables
    // (reconciliation_matches, lot_ledger_entries) that may not exist yet
    // in this environment. Don't let a matcher failure break the import.
    try {
      const result = await autoMatchBankTransactions(
        ocId,
        insertedIds,
        profile.id,
      );
      autoMatched = result.matched;
    } catch (err) {
      console.error("auto-match orchestrator failed", err);
    }
  }

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "import",
    entity_type: "bank_account",
    entity_id: accountId,
    after_state: {
      transactions_imported: inserts.length,
      auto_matched: autoMatched,
    },
  });

  revalidatePath("/ocs/[ocCode]/bank-accounts", "page");
  revalidatePath("/ocs/[ocCode]/reconciliation", "page");
  return { inserted: inserts.length, auto_matched: autoMatched };
}

/**
 * Create a new bank account for an OC. Triggered from the "+" tab on the
 * bank accounts page. The new row is unlinked , no fund_type / fund_id
 * gets set here. A separate step on the funds page links it to a fund.
 */
export async function createBankAccount(
  ocId: string,
  data: {
    account_name: string;
    bsb: string;
    account_number: string;
    bank_name: string | null;
  },
): Promise<{ id?: string; error?: string }> {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);

  const accountName = data.account_name.trim();
  const bsb = data.bsb.trim();
  const accountNumber = data.account_number.trim();
  if (!accountName) return { error: "Account name is required." };
  if (!/^\d{3}-?\d{3}$/.test(bsb)) return { error: "BSB must be 6 digits." };
  if (!/^\d{6,9}$/.test(accountNumber)) return { error: "Account number must be 6-9 digits." };

  const supabase = createServerClient();

  // If this is the OC's first bank account, auto-link it to the OC's
  // operating ("admin") fund — that's the account the admin fund draws
  // to/from. We only do this when there are zero existing bank_accounts;
  // subsequent accounts can be linked from the funds page like usual.
  const { count: existingCount } = await supabase
    .from("bank_accounts")
    .select("id", { count: "exact", head: true })
    .eq("oc_id", ocId);

  let operatingFundId: string | null = null;
  if (!existingCount || existingCount === 0) {
    const { data: opFund } = await supabase
      .from("funds")
      .select("id")
      .eq("oc_id", ocId)
      .eq("kind", "admin")
      .maybeSingle();
    operatingFundId = opFund?.id ?? null;
  }

  const { data: row, error } = await supabase
    .from("bank_accounts")
    .insert({
      oc_id: ocId,
      fund_type: "operating",
      fund_id: operatingFundId,
      account_name: accountName,
      bsb,
      account_number: accountNumber,
      bank_name: data.bank_name || null,
    })
    .select("id")
    .single();

  if (error || !row) return { error: error?.message ?? "Could not create bank account." };

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "create",
    entity_type: "bank_account",
    entity_id: row.id,
    after_state: {
      account_name: accountName,
      bsb,
      account_number: accountNumber,
      bank_name: data.bank_name,
    },
  });

  revalidatePath("/ocs/[ocCode]/bank-accounts", "page");
  return { id: row.id };
}

/**
 * Delete a physical bank account. Allowed only while the OC keeps at least
 * one other physical account , an OC with no account has nowhere to receive
 * levies. The surviving account is promoted to the primary operating one
 * (fund_type='operating'), which is what the levy notice EFT block and the
 * account tab order both key off, and it adopts any fund the deleted
 * account was linked to so no fund is left without an account.
 *
 * Imported statement lines go with the account (FK cascade). Accounts with
 * fund transfers or banked receipts against them are refused , those are
 * posted financial records, not a re-importable statement.
 */
export async function deleteBankAccount(
  ocId: string,
  accountId: string,
): Promise<{ promotedAccountId?: string; error?: string }> {
  const profile = await requireCompanyRole();
  await requireOCAccess(ocId);
  const supabase = createServerClient();

  const { data: accounts } = await supabase
    .from("bank_accounts")
    .select("id, account_name, bsb, account_number, bank_name, fund_type, fund_id, parent_account_id, created_at")
    .eq("oc_id", ocId);

  type Row = {
    id: string;
    account_name: string | null;
    bsb: string | null;
    account_number: string | null;
    bank_name: string | null;
    fund_type: string;
    fund_id: string | null;
    parent_account_id: string | null;
    created_at: string;
  };
  const all = (accounts ?? []) as Row[];
  const target = all.find((a) => a.id === accountId);
  if (!target) return { error: "Bank account not found." };
  if (target.parent_account_id) {
    return { error: "This is a fund's link to a shared account. Remove it from the funds page." };
  }

  const physical = all.filter((a) => !a.parent_account_id);
  if (physical.length <= 1) {
    return { error: "This is the only bank account for this Owners Corporation. Add another one before deleting it." };
  }

  // The account plus every fund-link row hanging off it.
  const children = all.filter((a) => a.parent_account_id === accountId);
  const doomedIds = [accountId, ...children.map((c) => c.id)];

  const [transfers, receipts] = await Promise.all([
    supabase
      .from("fund_transfers")
      .select("id", { count: "exact", head: true })
      .or(
        `from_bank_account_id.in.(${doomedIds.join(",")}),to_bank_account_id.in.(${doomedIds.join(",")})`,
      ),
    supabase
      .from("undeposited_funds_entries")
      .select("id", { count: "exact", head: true })
      .in("bank_account_id", doomedIds),
  ]);
  if (transfers.count) {
    return { error: "This account has fund transfers recorded against it, so it can't be deleted." };
  }
  if (receipts.count) {
    return { error: "This account has receipts banked to it, so it can't be deleted." };
  }

  // Successor: an account already flagged operating if there is one,
  // otherwise the oldest survivor. Deterministic either way, so the tab
  // order after the delete matches what the manager was told.
  const remaining = physical
    .filter((a) => a.id !== accountId)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  const successor = remaining.find((a) => a.fund_type === "operating") ?? remaining[0];

  // Funds that lose their account when this one goes. Re-point them at the
  // successor: straight onto it while it has no fund of its own, otherwise
  // as a shared-account child row (the same shape the funds page creates).
  const stillLinkedFundIds = new Set(
    all
      .filter((a) => !doomedIds.includes(a.id))
      .map((a) => a.fund_id)
      .filter((id): id is string => !!id),
  );
  const orphanedFundIds = [target.fund_id, ...children.map((c) => c.fund_id)]
    .filter((id): id is string => !!id)
    .filter((id) => !stillLinkedFundIds.has(id));

  let successorFundId = successor.fund_id;
  const childInserts: Array<{
    oc_id: string;
    fund_id: string;
    fund_type: string;
    parent_account_id: string;
    account_name: string;
  }> = [];
  for (const fundId of orphanedFundIds) {
    if (!successorFundId) {
      successorFundId = fundId;
      continue;
    }
    const { data: fund } = await supabase
      .from("funds")
      .select("name, kind")
      .eq("id", fundId)
      .maybeSingle();
    const f = fund as { name: string; kind: string } | null;
    childInserts.push({
      oc_id: ocId,
      fund_id: fundId,
      fund_type: f?.kind === "maintenance_plan" ? "maintenance_plan" : "operating",
      parent_account_id: successor.id,
      account_name: f?.name ?? successor.account_name ?? "Bank account",
    });
  }

  // Children first , they point at the row we're about to remove.
  if (children.length > 0) {
    const { error: childErr } = await supabase
      .from("bank_accounts")
      .delete()
      .in("id", children.map((c) => c.id));
    if (childErr) return { error: "Could not delete this bank account." };
  }
  const { error: delErr } = await supabase
    .from("bank_accounts")
    .delete()
    .eq("id", accountId)
    .eq("oc_id", ocId);
  if (delErr) {
    console.error("deleteBankAccount: delete failed", delErr);
    return { error: "Could not delete this bank account." };
  }

  // Promote the survivor. fund_type is the legacy flag the levy EFT lookup
  // and the tab sort still read, so the OC always has one account marked
  // operating.
  const { error: promoteErr } = await supabase
    .from("bank_accounts")
    .update({ fund_type: "operating", fund_id: successorFundId })
    .eq("id", successor.id);
  if (promoteErr) console.error("deleteBankAccount: promote failed", promoteErr);

  if (childInserts.length > 0) {
    const { error: reparentErr } = await supabase.from("bank_accounts").insert(childInserts);
    if (reparentErr) console.error("deleteBankAccount: fund re-link failed", reparentErr);
  }

  await supabase.from("audit_log").insert({
    profile_id: profile.id,
    oc_id: ocId,
    action: "delete",
    entity_type: "bank_account",
    entity_id: accountId,
    before_state: {
      account_name: target.account_name,
      bsb: target.bsb,
      account_number: target.account_number,
      bank_name: target.bank_name,
      fund_type: target.fund_type,
      fund_id: target.fund_id,
      linked_fund_rows: children.length,
    },
    after_state: {
      promoted_account_id: successor.id,
      promoted_account_name: successor.account_name,
      funds_relinked: orphanedFundIds.length,
    },
  });

  revalidatePath("/ocs/[ocCode]/bank-accounts", "page");
  revalidatePath("/ocs/[ocCode]/funds", "page");
  revalidatePath("/ocs/[ocCode]/reconciliation", "page");
  return { promotedAccountId: successor.id };
}
