import { useState } from "react";
import {
  BookOpen,
  FileText,
  Database,
  Loader2,
  AlertCircle,
  AlertTriangle,
  Square,
  Trash2,
  Eraser,
  MoreHorizontal,
  Eye,
  EyeOff,
  ExternalLink,
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
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { StatCard } from "@/components/stat-card";
import { PrettyAmount } from "@/components/pretty-amount";
import type {
  UseDocsContextUsageReturn,
  UseRemoveDocsContextCodebaseReturn,
  UseStopDocsContextJobReturn,
  UseClearDocsContextJobReturn,
  UseHideDocsContextCodebaseReturn,
  UseUnhideDocsContextCodebaseReturn,
} from "@/hooks/use-plugins";

interface Props {
  query: UseDocsContextUsageReturn;
  isAdmin: boolean;
  removeCodebase: UseRemoveDocsContextCodebaseReturn;
  stopJob: UseStopDocsContextJobReturn;
  clearJob: UseClearDocsContextJobReturn;
  hideCodebase: UseHideDocsContextCodebaseReturn;
  unhideCodebase: UseUnhideDocsContextCodebaseReturn;
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

type StopTarget = { codebaseId: string; ref: string };
type RemoveTarget = { codebaseId: string };
type ClearTarget = { codebaseId: string; ref: string };

export function DocsContextStats({
  query,
  isAdmin,
  removeCodebase,
  stopJob,
  clearJob,
  hideCodebase,
  unhideCodebase,
}: Props) {
  const { data, isLoading, error } = query;
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [clearTarget, setClearTarget] = useState<ClearTarget | null>(null);

  // The docs section sits below the code section on the same tab. When there
  // are no docs at all (no indexed sites and no active jobs), we render
  // nothing — no need for an empty placeholder, since the code section is
  // already there. If the user just installed the plugin and only has code
  // indexed, the docs hint above the `Indexing in Progress` shouldn't compete
  // for attention.
  if (isLoading) return null;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load docs-context usage: {error instanceof Error ? error.message : "unknown error"}
      </p>
    );
  }
  const hasIndexed = data && data.totals.sites > 0;
  const hasActive = data && data.indexing && data.indexing.length > 0;
  if (!hasIndexed && !hasActive) return null;

  return (
    <div className="space-y-4">
      {hasActive && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="w-4 h-4" />
              Docs Indexing in Progress
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data!.indexing.map((job) => (
              <div
                key={`${job.codebaseId}#${job.ref}`}
                className={`space-y-1 ${job.hidden ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 font-mono text-muted-foreground truncate min-w-0">
                    {job.status === "indexing" ? (
                      <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
                    ) : (
                      <AlertCircle className="w-3 h-3 shrink-0 text-destructive" />
                    )}
                    <span className="truncate">{job.codebaseId}</span>
                    {job.baseUrl && (
                      <a
                        href={job.baseUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center text-muted-foreground hover:text-foreground"
                        title={job.baseUrl}
                      >
                        <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                      </a>
                    )}
                    {job.hidden && (
                      <span
                        className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal shrink-0"
                        title="Hidden from non-admin users"
                      >
                        <EyeOff className="w-3 h-3" />
                        hidden
                      </span>
                    )}
                  </span>
                  <div className="shrink-0 flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {job.status === "failed"
                        ? "failed"
                        : job.status === "cancelled"
                          ? "cancelled"
                          : `${Math.round(job.percentage)}%`}
                    </span>
                    {isAdmin && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 w-6 p-0"
                            aria-label="Actions"
                          >
                            <MoreHorizontal className="w-3 h-3" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-44 p-1">
                          <div className="flex flex-col">
                            {job.status === "indexing" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="justify-start h-8 px-2 text-xs"
                                onClick={() =>
                                  setStopTarget({ codebaseId: job.codebaseId, ref: job.ref })
                                }
                                disabled={stopJob.isPending}
                              >
                                <Square className="w-3 h-3 mr-2" />
                                Stop
                              </Button>
                            )}
                            {(job.status === "failed" || job.status === "cancelled") && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="justify-start h-8 px-2 text-xs"
                                onClick={() =>
                                  setClearTarget({ codebaseId: job.codebaseId, ref: job.ref })
                                }
                                disabled={clearJob.isPending}
                              >
                                <Eraser className="w-3 h-3 mr-2" />
                                Clear
                              </Button>
                            )}
                            {job.hidden ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="justify-start h-8 px-2 text-xs"
                                onClick={() => unhideCodebase.mutate(job.codebaseId)}
                                disabled={unhideCodebase.isPending}
                              >
                                <Eye className="w-3 h-3 mr-2" />
                                Unhide
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="justify-start h-8 px-2 text-xs"
                                onClick={() => hideCodebase.mutate(job.codebaseId)}
                                disabled={hideCodebase.isPending}
                              >
                                <EyeOff className="w-3 h-3 mr-2" />
                                Hide
                              </Button>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                </div>
                {job.status === "indexing" && (
                  <div className="h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${job.percentage}%` }}
                    />
                  </div>
                )}
                {(job.status === "failed" || job.status === "cancelled") && job.error && (
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
              title="Docs Sites"
              value={<PrettyAmount amountFormatted={data!.totals.sites} size="2xl" normalPrecision={0} />}
              icon={BookOpen}
            />
            <StatCard
              title="Pages"
              value={<PrettyAmount amountFormatted={data!.totals.pages} size="2xl" normalPrecision={0} />}
              icon={FileText}
            />
            <StatCard
              title="Chunks"
              value={<PrettyAmount amountFormatted={data!.totals.chunks} size="2xl" normalPrecision={0} />}
              icon={Database}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Indexed Docs</CardTitle>
              <CardDescription>
                Documentation sites crawled and embedded for semantic search. Re-mentioning a base
                URL in chat re-checks the index — unchanged pages are kept, changed pages re-embed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b">
                      <th className="py-2 pr-4 font-medium">Site</th>
                      <th className="py-2 pr-4 font-medium">Base URL</th>
                      <th className="py-2 pr-4 font-medium">Pages</th>
                      <th className="py-2 pr-4 font-medium">Chunks</th>
                      <th className="py-2 pr-4 font-medium">Indexed</th>
                      {isAdmin && <th className="py-2 pr-4 font-medium sr-only">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data!.sites.map((s) => (
                      <tr
                        key={`${s.codebaseId}#${s.ref}`}
                        className={`border-b last:border-b-0 align-top ${s.hidden ? "opacity-50" : ""}`}
                      >
                        <td className="py-2 pr-4 font-mono text-xs break-all">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span title={s.collection}>{s.codebaseId}</span>
                            {s.hidden && (
                              <span
                                className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]"
                                title="Hidden from non-admin users"
                              >
                                <EyeOff className="w-3 h-3" />
                                hidden
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-4 text-xs">
                          {s.baseUrl ? (
                            <a
                              href={s.baseUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground break-all"
                            >
                              {s.baseUrl}
                              <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">{s.pages.toLocaleString()}</td>
                        <td className="py-2 pr-4">{s.chunks.toLocaleString()}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{formatRelative(s.updatedAt)}</td>
                        {isAdmin && (
                          <td className="py-2 pr-4 text-right">
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  aria-label="Actions"
                                >
                                  <MoreHorizontal className="w-3.5 h-3.5" />
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent align="end" className="w-44 p-1">
                                <div className="flex flex-col">
                                  {s.hidden ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="justify-start h-8 px-2 text-xs"
                                      onClick={() => unhideCodebase.mutate(s.codebaseId)}
                                      disabled={unhideCodebase.isPending}
                                    >
                                      <Eye className="w-3 h-3 mr-2" />
                                      Unhide
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="justify-start h-8 px-2 text-xs"
                                      onClick={() => hideCodebase.mutate(s.codebaseId)}
                                      disabled={hideCodebase.isPending}
                                    >
                                      <EyeOff className="w-3 h-3 mr-2" />
                                      Hide
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="justify-start h-8 px-2 text-xs text-destructive hover:text-destructive"
                                    onClick={() => setRemoveTarget({ codebaseId: s.codebaseId })}
                                    disabled={removeCodebase.isPending}
                                  >
                                    <Trash2 className="w-3 h-3 mr-2" />
                                    Remove
                                  </Button>
                                </div>
                              </PopoverContent>
                            </Popover>
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
              Stop the running crawl for{" "}
              <strong className="font-mono break-all">{stopTarget?.codebaseId}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-muted-foreground">
              Pages already crawled and embedded stay in the collection — you can resume later
              without re-embedding them.
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
              {stopJob.isPending ? "Stopping…" : "Stop Indexing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear terminal job */}
      <Dialog open={clearTarget !== null} onOpenChange={(open) => { if (!open) setClearTarget(null); }}>
        <DialogContent className="sm:max-w-[460px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eraser className="h-5 w-5" />
              Clear Job Entry
            </DialogTitle>
            <DialogDescription>
              Remove the job row for{" "}
              <strong className="font-mono break-all">{clearTarget?.codebaseId}</strong> from the
              panel?
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-muted-foreground">
              The overlay and job row are removed; embedded chunks are kept so the next index_docs
              run reuses them.
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
              {clearJob.isPending ? "Clearing…" : "Clear Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove docs site */}
      <Dialog open={removeTarget !== null} onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}>
        <DialogContent className="sm:max-w-[460px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Remove Docs Site
            </DialogTitle>
            <DialogDescription>
              Permanently drop all pages, overlays, and chunks for{" "}
              <strong className="font-mono break-all">{removeTarget?.codebaseId}</strong>?
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-xs text-ui-danger-fg">
              This action cannot be undone. The next mention of this URL will re-crawl from scratch.
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
              {removeCodebase.isPending ? "Removing…" : "Remove Docs Site"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
