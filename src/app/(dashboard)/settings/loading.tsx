import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {/* Line tabs skeleton */}
      <div className="flex gap-6 border-b border-border">
        <div className="pb-2 border-b-2 border-foreground">
          <span className="text-sm font-medium">Profile</span>
        </div>
        <div className="pb-2">
          <span className="text-sm text-muted-foreground">Security</span>
        </div>
        <div className="pb-2">
          <span className="text-sm text-muted-foreground">Notifications</span>
        </div>
      </div>

      {/* Profile form skeleton */}
      <Card>
        <CardContent className="pt-5 space-y-4">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <Skeleton className="h-16 w-16 rounded-full" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>

          {/* Phone field */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Phone</span>
            <Skeleton className="h-9 w-full rounded-md" />
          </div>

          {/* Postal address field */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Postal address</span>
            <Skeleton className="h-9 w-full rounded-md" />
          </div>

          {/* Fixed action , render it rather than shimmer a grey pill. */}
          <Button disabled>Save changes</Button>
        </CardContent>
      </Card>
    </div>
  );
}
