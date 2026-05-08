import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { PrettyDate } from "@/components/pretty-date";

interface Props {
  /** Wall-clock timestamp of the last successful fetch. From react-query's `dataUpdatedAt`. */
  dataUpdatedAt: number;
  /** True while a refetch is in flight — drives a small spinner instead of the static label. */
  isFetching: boolean;
  /** Optional manual refresh callback — when provided, the indicator becomes a button. */
  onRefresh?: () => void;
  className?: string;
}

/**
 * Tiny header badge that surfaces how stale the displayed plugin data is and
 * pulses briefly while a background refetch is running. PrettyDate renders
 * the actual "23s ago" label so it stays consistent with the rest of the app.
 *
 * The component re-renders itself once a second so the relative label keeps
 * counting up between gateway polls; PrettyDate's relative format reads its
 * input on render, so it'd otherwise stick at the last react-rendered value.
 */
export function PluginFreshness({
  dataUpdatedAt,
  isFetching,
  onRefresh,
  className,
}: Props) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!dataUpdatedAt) {
    return null;
  }

  const body = (
    <>
      <RefreshCw
        className={cn(
          "h-3 w-3 text-muted-foreground/70",
          isFetching && "animate-spin text-primary",
        )}
      />
      <span className="text-muted-foreground">Updated</span>
      <PrettyDate
        date={dataUpdatedAt}
        format="relative"
        size="xs"
        className="text-xs"
      />
    </>
  );

  const baseClass = cn(
    "inline-flex items-center gap-1.5 text-xs",
    className,
  );

  if (onRefresh) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        disabled={isFetching}
        className={cn(
          baseClass,
          "rounded-md border border-transparent px-1.5 py-0.5 hover:border-border hover:bg-muted",
          "disabled:opacity-60 disabled:cursor-progress",
        )}
        aria-label="Refresh plugin data"
        title="Refresh"
      >
        {body}
      </button>
    );
  }

  return <span className={baseClass}>{body}</span>;
}
