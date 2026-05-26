import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium",
  {
    variants: {
      variant: {
        neutral: "border-border bg-muted text-muted-foreground",
        verified:
          "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        inaccurate:
          "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
        falseVerdict:
          "border-red-500/35 bg-red-500/12 text-red-700 dark:text-red-300",
        unverifiable:
          "border-slate-500/35 bg-slate-500/12 text-slate-700 dark:text-slate-300",
        high:
          "border-emerald-500/30 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        medium:
          "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300",
        low:
          "border-red-500/35 bg-red-500/12 text-red-700 dark:text-red-300",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}
