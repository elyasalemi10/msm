import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Loading state for the OC documents library.
//
// The Upload / Export ZIP toolbar is fixed, so it renders for real and just
// sits disabled until the list arrives. Only the document tiles shimmer.
//
// The previous version drew a single card of stacked list rows, which is not
// the shape DocumentManager renders at all , it lays documents out as a
// responsive card grid with a thumbnail block, so the skeleton visibly
// re-flowed into something else once the data landed.
//
// Mirrors components/shared/document-manager.tsx.

const TILES = 8;

export default function DocumentsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" disabled>
            <Upload className="mr-2 h-3.5 w-3.5" />
            Upload
          </Button>
          <Button variant="outline" size="sm" disabled>
            <Download className="mr-2 h-3.5 w-3.5" />
            Export ZIP
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: TILES }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-3">
                <Skeleton className="mb-3 h-24 w-full rounded-md" />
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="mt-1.5 h-3 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
