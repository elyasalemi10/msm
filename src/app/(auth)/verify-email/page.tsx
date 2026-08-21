"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/shared/otp-input";
import Image from "next/image";
import { sendVerificationCode, verifyEmailCode } from "@/lib/actions/email-verification";
import { getSupabaseClient } from "@/lib/supabase";

// Gmail web client deep-link that pre-filters to our sender so the user
// finds the code instantly. This is the browser-side twin of RESEND_SUFFIX,
// which isn't NEXT_PUBLIC_ and so can't be read from a client component.
const SENDER_DOMAIN =
  process.env.NEXT_PUBLIC_SENDER_DOMAIN ?? "stratawise.com.au";
const GMAIL_SEARCH_URL = `https://mail.google.com/mail/u/0/#search/from%3A%40${encodeURIComponent(SENDER_DOMAIN)}`;

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") ?? "/onboarding";
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [resending, setResending] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const autoSent = useRef(false);

  // Resolve the signed-in user's email so we can show it explicitly.
  // First check the sessionStorage breadcrumb signup-flow leaves, then
  // fall back to a Supabase Auth lookup.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const cached = sessionStorage.getItem("verifyEmail.email");
    if (cached) {
      setUserEmail(cached);
      return;
    }
    getSupabaseClient().auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
  }, []);

  // Auto-send a code on first mount.
  useEffect(() => {
    if (autoSent.current) return;
    if (typeof window === "undefined") return;
    autoSent.current = true;
    if (sessionStorage.getItem("verifyEmail.codeSent") === "1") return;
    sendVerificationCode().then((r) => {
      if ("error" in r) {
        toast.error(r.error);
      } else {
        sessionStorage.setItem("verifyEmail.codeSent", "1");
        toast.success("Code sent to your email.");
      }
    });
  }, []);

  async function handleVerify(value: string) {
    setVerifying(true);
    setInvalid(false);
    const result = await verifyEmailCode(value);

    if ("error" in result) {
      setInvalid(true);
      setVerifying(false);
      toast.error(result.error);
      return;
    }

    // Soft client navigation so the shared auth layout doesn't repaint
    // (avoids the brief icon-only flash). Button stays greyed through it.
    sessionStorage.removeItem("verifyEmail.codeSent");
    sessionStorage.removeItem("verifyEmail.email");
    router.push(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) {
      setInvalid(true);
      toast.error("Enter all 6 digits.");
      return;
    }
    await handleVerify(code);
  }

  async function handleResend() {
    setResending(true);
    const result = await sendVerificationCode();
    setResending(false);

    if ("error" in result) {
      toast.error(result.error);
      return;
    }
    setCode("");
    setInvalid(false);
    sessionStorage.setItem("verifyEmail.codeSent", "1");
    toast.success("New code sent.");
  }

  return (
    <div className="w-full space-y-8">
      {/* Cancel sign-up , X in the top-right (clears the half-created
          session via /logout; the unverified account can be resumed later). */}
      <a
        href="/logout"
        aria-label="Cancel and sign out"
        className="fixed right-4 top-4 z-10 inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="h-5 w-5" />
      </a>
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Verify your email
        </h1>
        <p className="mt-3 text-base text-muted-foreground leading-relaxed">
          Enter the 6-digit code we sent to{" "}
          <strong className="text-foreground">
            {userEmail ?? "your email"}
          </strong>
          .
        </p>
        <div className="mt-4 flex justify-center">
          <a
            href={GMAIL_SEARCH_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            {/* Forcing the gmail.webp into a 16×16 square stretched the
                envelope shape. Keep the natural aspect ratio by setting
                height only and letting width auto-size via Tailwind. */}
            <Image
              src="/logos/gmail.webp"
              alt=""
              width={22}
              height={16}
              className="h-4 w-auto"
            />
            Open in Gmail
          </a>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mx-auto w-full max-w-sm space-y-4">
        <OtpInput
          value={code}
          onChange={(v) => {
            setCode(v);
            if (invalid) setInvalid(false);
          }}
          onComplete={(v) => handleVerify(v)}
          disabled={verifying}
          invalid={invalid}
          autoFocus
        />

        <Button
          type="submit"
          className="w-full h-11 border border-foreground/15 shadow-sm"
          disabled={verifying || code.length !== 6}
        >
          {verifying && <Loader2 className="size-4 animate-spin" />}
          Verify email
        </Button>
      </form>

      <div className="text-center text-sm text-muted-foreground">
        Didn&apos;t get the code?{" "}
        <button
          type="button"
          disabled={resending}
          onClick={handleResend}
          className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
        >
          {resending && <Loader2 className="size-3 animate-spin" />}
          Resend
        </button>
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Code expires in 10 minutes. Check your spam folder.
      </p>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  );
}
