import { Building2, DollarSign, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

function KPICardSkeleton({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </p>
            <Skeleton className="mt-2 h-7 w-12" />
          </div>
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
            {icon}
          </div>
        </div>
        <Skeleton className="mt-3 h-3 w-28" />
      </CardContent>
    </Card>
  );
}

export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      {/* KPI cards , labels + icons visible, values shimmer */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KPICardSkeleton label="OCs" icon={<Building2 className="h-5 w-5" />} />
        <KPICardSkeleton label="Total lots" icon={<Users className="h-5 w-5" />} />
        <KPICardSkeleton label="Total levied" icon={<DollarSign className="h-5 w-5" />} />
        <KPICardSkeleton label="Outstanding" icon={<DollarSign className="h-5 w-5" />} />
      </div>

      {/* Section heading and its action are both fixed , render them. */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">OCs</h2>
        <Button size="sm" disabled>
          <Plus className="mr-2 h-4 w-4" />
          Create OC
        </Button>
      </div>

      {/* OC cards skeleton */}
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
