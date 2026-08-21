import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Loading state for the meetings list.
//
// The toolbar and the table's column headings are fixed, so they render for
// real. Only the count and the row values come from the server.
//
// The previous version shimmered a centred icon + two lines of text, which
// was a skeleton of the EMPTY state. That guessed at the answer before the
// data arrived, so an OC with meetings saw a fake "nothing here" shape and
// then a table, which is a worse transition than showing table chrome that
// turns out to be correct either way.
//
// Mirrors meetings-content.tsx. Keep the header list in step with it.

const ROWS = 5;

export default function MeetingsLoading() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-20" />
        <Button size="sm" disabled>
          <Plus className="mr-2 h-3.5 w-3.5" />
          Create meeting
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <Table variant="striped">
          <TableHeader>
            <TableRow>
              <TableHead>Reference</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>When</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: ROWS }).map((_, i) => (
              <TableRow key={i}>
                <TableCell><Skeleton className="h-3.5 w-36" /></TableCell>
                <TableCell><Skeleton className="h-3.5 w-16" /></TableCell>
                <TableCell><Skeleton className="h-3.5 w-52" /></TableCell>
                <TableCell><Skeleton className="h-3.5 w-28" /></TableCell>
                <TableCell><Skeleton className="h-5 w-20 rounded-full" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
