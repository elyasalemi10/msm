"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type EnvEntry = { key: string; value: string | null };

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleCopy}>
      {copied ? (
        <Check className="mr-1.5 size-3.5" />
      ) : (
        <Copy className="mr-1.5 size-3.5" />
      )}
      {label}
    </Button>
  );
}

export function EnvDump({ entries }: { entries: EnvEntry[] }) {
  const present = entries.filter((e) => e.value !== null);
  const missing = entries.filter((e) => e.value === null);

  const envFile = present.map((e) => `${e.key}=${e.value}`).join("\n");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {present.length} set, {missing.length} not set
        </p>
        <CopyButton text={envFile} label="Copy all as .env" />
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table variant="bordered">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[22rem]">Variable</TableHead>
              <TableHead>Value</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.key}>
                <TableCell className="align-top font-mono text-xs">
                  {e.key}
                </TableCell>
                <TableCell className="align-top">
                  {e.value === null ? (
                    <span className="text-sm text-muted-foreground">
                      Not set
                    </span>
                  ) : (
                    <code className="block max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-cool-muted px-2 py-1.5 font-mono text-xs text-cool-muted-foreground">
                      {e.value}
                    </code>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  {e.value !== null && (
                    <CopyButton text={e.value} label="Copy" />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
