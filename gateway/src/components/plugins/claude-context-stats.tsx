import { FolderTree, FileCode, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { PrettyAmount } from "@/components/pretty-amount";
import type { UseClaudeContextUsageReturn } from "@/hooks/use-plugins";

interface Props {
  query: UseClaudeContextUsageReturn;
}

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function ClaudeContextStats({ query }: Props) {
  const { data, isLoading, error } = query;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load claude-context usage: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }
  if (!data || data.totals.codebases === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-10 gap-3">
          <FolderTree className="w-10 h-10 text-muted-foreground opacity-40" />
          <p className="text-sm text-muted-foreground text-center">
            No codebases indexed yet.
          </p>
          <p className="text-xs text-muted-foreground text-center">
            Install the <strong>claude-context</strong> plugin and run the{" "}
            <code className="text-xs">index_codebase</code> tool in Claude Code to populate this view.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          title="Codebases"
          value={<PrettyAmount amountFormatted={data.totals.codebases} size="2xl" normalPrecision={0} />}
          icon={FolderTree}
        />
        <StatCard
          title="Files"
          value={<PrettyAmount amountFormatted={data.totals.files} size="2xl" normalPrecision={0} />}
          icon={FileCode}
        />
        <StatCard
          title="Chunks"
          value={<PrettyAmount amountFormatted={data.totals.chunks} size="2xl" normalPrecision={0} />}
          icon={Database}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Indexed Codebases</CardTitle>
          <CardDescription>
            What <code>index_codebase</code> has stored on this gateway (shared across keys).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b">
                  <th className="py-2 pr-4 font-medium">Codebase</th>
                  <th className="py-2 pr-4 font-medium">Files</th>
                  <th className="py-2 pr-4 font-medium">Chunks</th>
                  <th className="py-2 pr-4 font-medium">Dim</th>
                  <th className="py-2 pr-4 font-medium">Indexed</th>
                </tr>
              </thead>
              <tbody>
                {data.collections.map((c) => (
                  <tr key={c.name} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-mono text-xs break-all">
                      {c.codebasePath ? (
                        <span title={c.name}>{c.codebasePath}</span>
                      ) : (
                        <span className="text-muted-foreground">{c.name}</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{c.files.toLocaleString()}</td>
                    <td className="py-2 pr-4">{c.chunks.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{c.dimension}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{formatRelative(c.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
