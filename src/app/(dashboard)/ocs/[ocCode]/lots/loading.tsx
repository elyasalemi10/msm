import { ArrowUpDown, ChevronDown, Search, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Loading state for the lots register.
//
// Everything on this page that is FIXED renders for real: the search box,
// the Sort and Tools buttons, the table chrome and its column headings. None
// of that depends on the server, so shimmering it just makes the page look
// like it is assembling itself from nothing, and it flickers when the real
// chrome swaps in behind it.
//
// The only thing the server actually decides is the cell values, so the
// only thing that shimmers is the cells. The controls are disabled until
// the data lands, otherwise a manager can type into a search box that is
// about to be replaced and lose the keystrokes.
//
// Mirrors lots-page-content.tsx + manage/lots-tab.tsx. Keep the colgroup
// widths and header list in step with lots-tab.tsx or the columns visibly
// jump on hydration.

const ROWS = 8;

export default function LotsLoading() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem] max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            disabled
            placeholder="Search lots, owners, email or phone"
            className="h-9 pl-8 pr-8"
          />
        </div>

        <Button variant="secondary" size="sm" disabled>
          <ArrowUpDown className="mr-2 h-3.5 w-3.5" />
          Sort: Lot number (low → high)
          <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-60" />
        </Button>

        <Button variant="secondary" size="sm" disabled>
          <Wrench className="mr-2 h-3.5 w-3.5" />
          Tools
          <ChevronDown className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-3">
        <div className="rounded-lg border border-border overflow-hidden">
          <Table variant="striped" className="table-fixed">
            <colgroup>
              <col className="w-28" />
              <col className="w-28" />
              <col />
              <col className="w-[22%]" />
              <col className="w-40" />
              <col className="w-40" />
              <col className="w-32" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Lot number</TableHead>
                <TableHead>Unit number</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Units of entitlement</TableHead>
                <TableHead>Invite status</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from({ length: ROWS }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell><Skeleton className="h-3.5 w-8" /></TableCell>
                  <TableCell><Skeleton className="h-3.5 w-10" /></TableCell>
                  <TableCell><Skeleton className="h-3.5 w-40" /></TableCell>
                  <TableCell><Skeleton className="h-3.5 w-full max-w-[13rem]" /></TableCell>
                  <TableCell><Skeleton className="h-3.5 w-12" /></TableCell>
                  <TableCell><Skeleton className="h-5 w-24 rounded-full" /></TableCell>
                  <TableCell className="flex justify-end"><Skeleton className="h-3.5 w-16" /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
