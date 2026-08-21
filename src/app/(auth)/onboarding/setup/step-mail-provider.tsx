"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Mail,
  Globe,
  ShieldCheck,
  CheckCircle2,
  Building2,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { saveMailProvider } from "./actions";

// Step 3 of onboarding. The manager picks where outbound mail comes from:
//   - stratawise: <username>@stratawise.com.au (default , no setup needed)
//   - gmail: their firm's Google Workspace mailbox via Domain-Wide Delegation
//
// Reading + sending only. We make that explicit in the copy. Customers can
// change or disconnect from /settings later , disconnecting falls back to
// stratawise so outbound never breaks silently.
//
// Today: stratawise is wired end-to-end. gmail captures the choice +
// domain; the actual transport flips on once the customer authorises us
// in their admin console.

type Provider = "stratawise" | "gmail";

export function StepMailProvider({
  onNext,
  onBack,
}: {
  onNext: () => void;
  onBack: () => void;
}) {
  const [choice, setChoice] = useState<"stratawise" | "own" | null>(null);
  const [domain, setDomain] = useState("");
  const [pending, setPending] = useState(false);

  async function handleContinue() {
    if (!choice) {
      toast.error("Pick how you want to send email.");
      return;
    }
    if (choice === "own" && !domain.trim()) {
      toast.error("Enter your firm's email domain.");
      return;
    }

    setPending(true);
    const finalProvider: Provider = choice === "stratawise" ? "stratawise" : "gmail";
    const res = await saveMailProvider({
      provider: finalProvider,
      domain: choice === "stratawise" ? null : domain.trim(),
    });
    setPending(false);

    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    onNext();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Where should your email come from?
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick one. You can change or disconnect anytime in Settings.
        </p>
      </div>

      {/* Two top-level cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => {
            setChoice("stratawise");
            setDomain("");
          }}
          className={cn(
            "flex h-full flex-col items-start gap-3 rounded-lg border-2 bg-card p-5 text-left transition-colors cursor-pointer",
            choice === "stratawise"
              ? "border-[color:var(--brand-gold)]"
              : "border-border hover:border-primary/40",
          )}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Mail className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">
              Use{" "}
              <span className="font-mono text-xs">
                yourname@stratawise.com.au
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Zero setup. We send + receive on our infrastructure. Replies
              come back into your StrataWise inbox.
            </p>
          </div>
          {choice === "stratawise" && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--brand-gold)]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Selected
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setChoice("own")}
          className={cn(
            "flex h-full flex-col items-start gap-3 rounded-lg border-2 bg-card p-5 text-left transition-colors cursor-pointer",
            choice === "own"
              ? "border-[color:var(--brand-gold)]"
              : "border-border hover:border-primary/40",
          )}
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Building2 className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">
              Connect your own Gmail
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Email sends from your real address. We only{" "}
              <strong className="text-foreground">read and send</strong> ,
              we never delete or move anything in your mailbox.
            </p>
          </div>
          {choice === "own" && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-[color:var(--brand-gold)]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Selected
            </span>
          )}
        </button>
      </div>

      {/* Sub-choice when "own" */}
      {choice === "own" && (
        <div className="rounded-lg border border-border bg-cool-muted p-4 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mail-domain">
              Email domain <span className="text-destructive">*</span>
            </Label>
            <Input
              id="mail-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acmestrata.com.au"
            />
            <p className="text-xs text-muted-foreground">
              The bit after the <span className="font-mono">@</span> in your
              firm&apos;s email address. We use this to send from each
              manager&apos;s own mailbox once you authorise us in your admin
              console.
            </p>
          </div>

          <GmailSetupCallout />

          <ReadWriteDisclosure />
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button type="button" variant="secondary" onClick={onBack}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Back
        </Button>
        <Button type="button" onClick={handleContinue} disabled={pending}>
          {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Finish setup
          <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function GmailSetupCallout() {
  return (
    <div className="rounded-md border border-border bg-card p-3 text-xs text-foreground space-y-2">
      <p className="font-medium uppercase tracking-wide text-muted-foreground">
        What you&apos;ll do next
      </p>
      <ol className="list-decimal pl-4 space-y-1 leading-relaxed">
        <li>
          Sign into{" "}
          <span className="font-mono">admin.google.com</span> as a super admin.
        </li>
        <li>
          Menu → Security → Access and data control → <em>API controls</em>.
        </li>
        <li>
          Click <em>Manage Domain Wide Delegation</em> → <em>Add new</em>.
        </li>
        <li>
          Paste the Client ID we&apos;ll show you on the next page (you can
          also find it in <em>Settings → Email integration</em> any time).
        </li>
        <li>
          Paste these OAuth scopes:
          <code className="ml-1 break-all rounded bg-cool-muted px-1.5 py-0.5 font-mono text-[11px]">
            https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.modify
          </code>
        </li>
        <li>Click Authorize.</li>
      </ol>
      <p className="text-muted-foreground">
        Usually works in minutes; Google sometimes takes up to 24 hours to
        propagate the grant.
      </p>
    </div>
  );
}

function ReadWriteDisclosure() {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-card p-3 text-xs text-foreground">
      <ShieldCheck className="h-4 w-4 shrink-0 text-[color:var(--brand-gold)]" />
      <div>
        <p className="font-medium">We won&apos;t delete anything.</p>
        <p className="mt-0.5 text-muted-foreground">
          StrataWise only{" "}
          <span className="font-medium text-foreground">reads</span> and{" "}
          <span className="font-medium text-foreground">sends</span> email.
          We don&apos;t move messages, change labels you set, or empty
          folders. You can revoke access from your admin console at any
          time , disconnecting falls back to{" "}
          <span className="font-mono">yourname@stratawise.com.au</span>.
        </p>
      </div>
    </div>
  );
}
