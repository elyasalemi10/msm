import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function OCsLoading() {
  return (
    <div className="space-y-6">
      {/* The count is server data so it shimmers; the action is fixed. */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-36" />
        <Button disabled>
          <Plus className="mr-2 h-4 w-4" />
          Create OC
        </Button>
      </div>

      {/* OC cards , same structure as loaded page */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-5">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-5 w-14 rounded-full" />
              </div>
              <Skeleton className="mt-2 h-3 w-20" />
              <div className="mt-4 flex items-center gap-1">
                <Skeleton className="h-3 w-3" />
                <Skeleton className="h-3 w-44" />
              </div>
              <div className="mt-3 border-t border-border pt-3">
                <Skeleton className="h-6 w-8" />
                <p className="mt-1 text-xs text-muted-foreground">Lots</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
