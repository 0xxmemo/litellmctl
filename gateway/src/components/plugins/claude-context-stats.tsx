import { useState } from "react";
import {
  FolderTree,
  FileCode,
  Database,
  GitBranch,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Square,
  Trash2,
  Eraser,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatCard } from "@/components/stat-card";
import { PrettyAmount } from "@/components/pretty-amount";
import type {
  UseClaudeContextUsageReturn,
  UseRemoveClaudeContextCodebaseReturn,
  UseStopClaudeContextJobReturn,
  UseClearClaudeContextJobReturn,
} from "@/hooks/use-plugins";

interface Props {
  query: UseClaudeContextUsageReturn;
  isAdmin: boolean;
  removeCodebase: UseRemoveClaudeContextCodebaseReturn;
  stopJob: UseStopClaudeContextJobReturn;
  clearJob: UseClearClaudeContextJobReturn;
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

type StopTarget = { codebaseId: string; branch: string };
type RemoveTarget = { codebaseId: string };
type ClearTarget = { codebaseId: string; branch: string };

export function ClaudeContextStats({ query, isAdmin, removeCodebase, stopJob, clearJob }: Props) {
  const { data, isLoading, error } = query;
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);

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
  const hasIndexed = data && data.totals.codebases > 0;
  const hasActive = data && data.indexing && data.indexing.length > 0;

  if (!hasIndexed && !hasActive) {
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
      {hasActive && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Indexing in Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data!.indexing.map((job) => (
              <div key={`${job.codebaseId}#${job.branch}`} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 font-mono text-muted-foreground truncate min-w-0">
                    {job.status === 'indexing' ? (
                      <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                    ) : (
                      <AlertCircle className="w-3 h-3 shrink-0 text-destructive" />
                    )}
                    <span className="truncate">{job.codebaseId}</span>
                    <GitBranch className="w-3 h-3 shrink-0 opacity-60" />
                    <span className="truncate">{job.branch}</span>
                  </span>
                  <div className="shrink-0 flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {job.status === 'failed'
                        ? 'failed'
                        : job.status === 'cancelled'
                          ? 'cancelled'
                          : `${Math.round(job.percentage)}%`}
                    </span>
                    {isAdmin && job.status === 'indexing' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          setStopTarget({ codebaseId: job.codebaseId, branch: job.branch })
                        }
                        disabled={stopJob.isPending}
                      >
                        <Square className="w-3 h-3 mr-1" />
                        Stop
                      </Button>
                    )}
                    {isAdmin && (job.status === 'failed' || job.status === 'cancelled') && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          setClearTarget({ codebaseId: job.codebaseId, branch: job.branch })
                        }
                        disabled={clearJob.isPending}
                      >
                        <Eraser className="w-3 h-3 mr-1" />
                        Clear
                      </Button>
                    )}
                  </div>
                </div>
                {job.status === 'indexing' && (
                  <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${job.percentage}%` }}
                    />
                  </div>
                )}
                {(job.status === 'failed' || job.status === 'cancelled') && job.error && (
                  <p className="text-xs text-destructive truncate">{job.error}</p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {hasIndexed && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              title="Codebases"
              value={<PrettyAmount amountFormatted={data!.totals.codebases} size="2xl" normalPrecision={0} />}
              icon={FolderTree}
            />
            <StatCard
              title="Files"
              value={<PrettyAmount amountFormatted={data!.totals.files} size="2xl" normalPrecision={0} />}
              icon={FileCode}
            />
            <StatCard
              title="Chunks"
              value={<PrettyAmount amountFormatted={data!.totals.chunks} size="2xl" normalPrecision={0} />}
              icon={Database}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Indexed Codebases</CardTitle>
              <CardDescription>
                Shared across every user of the same upstream repo. Branches are overlays — a file that
                exists on multiple branches stores its chunks once.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-2 pr-4 font-medium">Codebase</th>
                      <th className="py-2 pr-4 font-medium">Branches</th>
                      <th className="py-2 pr-4 font-medium">Files</th>
                      <th className="py-2 pr-4 font-medium">Chunks</th>
                      <th className="py-2 pr-4 font-medium">Dim</th>
                      <th className="py-2 pr-4 font-medium">Indexed</th>
                      {isAdmin && <th className="py-2 pr-4 font-medium sr-only">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data!.collections.map((c) => (
                      <tr key={c.name} className="border-b last:border-b-0 align-top">
                        <td className="py-2 pr-4 font-mono text-xs break-all">
                          {c.codebaseId ? (
                            <span title={c.name}>{c.codebaseId}</span>
                          ) : (
                            <span className="text-muted-foreground">{c.name}</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-xs">
                          {c.branches.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {c.branches.map((b) => (
                                <span
                                  key={b.branch}
                                  className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono"
                                  title={b.headCommit ? `HEAD ${b.headCommit.slice(0, 8)} · ${formatRelative(b.updatedAt)}` : formatRelative(b.updatedAt)}
                                >
                                  <GitBranch className="w-3 h-3 opacity-60" />
                                  {b.branch}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-4">{c.files.toLocaleString()}</td>
                        <td className="py-2 pr-4">{c.chunks.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{c.dimension}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{formatRelative(c.createdAt)}</td>
                        {isAdmin && (
                          <td className="py-2 pr-4 text-right">
                            {c.codebaseId && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => setRemoveTarget({ codebaseId: c.codebaseId! })}
                                disabled={removeCodebase.isPending}
                              >
                                <Trash2 className="w-3 h-3 mr-1" />
                                Remove
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* Stop job confirmation */}
      <Dialog open={stopTarget !== null} onOpenChange={(open) => { if (!open) setStopTarget(null); }}>
        <DialogContent className="sm:max-w-[460px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Stop Indexing
            </DialogTitle>
            <DialogDescription>
              Stop the running indexing job for{' '}
              <strong className="font-mono break-all">{stopTarget?.codebaseId}</strong>
              {' '}on branch <strong className="font-mono">{stopTarget?.branch}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-muted-foreground">
              The client CLI will abort at its next chunk upload. Chunks already embedded stay in the
              collection — you can resume the sync later without re-embedding them.
            </p>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setStopTarget(null)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={!stopTarget || stopJob.isPending}
              onClick={() => {
                if (!stopTarget) return;
                stopJob.mutate(stopTarget, {
                  onSettled: () => setStopTarget(null),
                });
              }}
            >
              {stopJob.isPending ? 'Stopping…' : 'Stop Indexing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear terminal job confirmation */}
      <Dialog open={clearTarget !== null} onOpenChange={(open) => { if (!open) setClearTarget(null); }}>
        <DialogContent className="sm:max-w-[460px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eraser className="h-5 w-5" />
              Clear Job Entry
            </DialogTitle>
            <DialogDescription>
              Remove the job row for{' '}
              <strong className="font-mono break-all">{clearTarget?.codebaseId}</strong>
              {' '}on branch <strong className="font-mono">{clearTarget?.branch}</strong> from the
              panel?
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-muted-foreground">
              Only this branch's overlay and job row are removed. Embedded chunks are kept — the next
              <code className="text-xs"> index_codebase</code> run reuses them.
            </p>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setClearTarget(null)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              className="w-full sm:w-auto"
              disabled={!clearTarget || clearJob.isPending}
              onClick={() => {
                if (!clearTarget) return;
                clearJob.mutate(clearTarget, {
                  onSettled: () => setClearTarget(null),
                });
              }}
            >
              {clearJob.isPending ? 'Clearing…' : 'Clear Entry'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove codebase confirmation */}
      <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
        <DialogContent className="sm:max-w-[460px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Remove Codebase
            </DialogTitle>
            <DialogDescription>
              Permanently drop all branches, overlays, and chunks for{' '}
              <strong className="font-mono break-all">{removeTarget?.codebaseId}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-ui-danger-fg">
              This action cannot be undone. Every user of this upstream repo will lose their indexed
              view — the next <code className="text-xs">index_codebase</code> call will re-embed from
              scratch.
            </p>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={!removeTarget || removeCodebase.isPending}
              onClick={() => {
                if (!removeTarget) return;
                removeCodebase.mutate(removeTarget.codebaseId, {
                  onSettled: () => setRemoveTarget(null),
                });
              }}
            >
              {removeCodebase.isPending ? 'Removing…' : 'Remove Codebase'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
