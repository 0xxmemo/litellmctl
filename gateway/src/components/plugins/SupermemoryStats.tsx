import { Brain, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatCard } from "@/components/StatCard";
import { PrettyAmount } from "@/components/PrettyAmount";
import type { UseSupermemoryUsageReturn } from "@/hooks/usePlugins";

interface Props {
  query: UseSupermemoryUsageReturn;
}

function formatDateLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function SupermemoryStats({ query }: Props) {
  const { data, isLoading, error } = query;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load supermemory usage: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }
  if (!data || !data.exists || data.total === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-10 gap-3">
          <Brain className="w-10 h-10 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground text-center">
            No memories saved yet.
          </p>
          <p className="text-xs text-muted-foreground text-center">
            Install the <strong>supermemory</strong> plugin and ask Claude Code to remember something
            (it'll call the <code className="text-xs">memory</code> tool).
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          title="Saved Memories"
          value={<PrettyAmount amountFormatted={data.total} size="2xl" normalPrecision={0} />}
          icon={Brain}
        />
        <StatCard
          title="Dimension"
          value={<PrettyAmount amountFormatted={data.dimension ?? 0} size="2xl" normalPrecision={0} />}
          icon={Sparkles}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Memories</CardTitle>
          <CardDescription>
            Newest {data.memories.length} of {data.total.toLocaleString()} memories stored on your API key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {data.memories.map((m) => (
              <li key={m.id} className="rounded-md border bg-muted/40 p-3 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <p className="flex-1 whitespace-pre-wrap break-words leading-relaxed">
                    {m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content}
                  </p>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDateLabel(m.createdAt)}
                  </span>
                </div>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {m.id}
                  {m.source ? ` · ${m.source}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
