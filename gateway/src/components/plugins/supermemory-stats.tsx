import { useMemo, useState } from "react";
import { AlertTriangle, Brain, ChevronRight, Sparkles, Trash2, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/stat-card";
import { PrettyAmount } from "@/components/pretty-amount";
import { PrettyDate } from "@/components/pretty-date";
import { PluginFreshness } from "./plugin-freshness";
import type {
  SupermemoryEntry,
  UseForgetSupermemoryMemoriesReturn,
  UseSupermemoryUsageReturn,
} from "@/hooks/use-plugins";

interface Props {
  query: UseSupermemoryUsageReturn;
  forgetMemories: UseForgetSupermemoryMemoriesReturn;
}

// Fixed, ordered set of time buckets — same labels for every project so the
// page reads uniformly regardless of how many memories any one project has.
const BUCKETS = [
  "Today",
  "Yesterday",
  "Last 7 days",
  "Last 30 days",
  "Older",
  "Undated",
] as const;
type Bucket = (typeof BUCKETS)[number];

const DAY = 24 * 60 * 60 * 1000;

function bucketFor(iso: string | null): Bucket {
  if (!iso) return "Undated";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Undated";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - DAY) return "Yesterday";
  if (t >= startOfToday - 7 * DAY) return "Last 7 days";
  if (t >= startOfToday - 30 * DAY) return "Last 30 days";
  return "Older";
}

function compareDesc(a: SupermemoryEntry, b: SupermemoryEntry): number {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (tb !== ta) return tb - ta;
  return a.id.localeCompare(b.id);
}

interface ProjectGroup {
  project: string;
  total: number;
  buckets: Array<{ bucket: Bucket; memories: SupermemoryEntry[] }>;
}

function groupByProjectAndBucket(
  memories: SupermemoryEntry[],
): ProjectGroup[] {
  const byProject = new Map<string, Map<Bucket, SupermemoryEntry[]>>();
  for (const m of memories) {
    const project = m.project || "default";
    let buckets = byProject.get(project);
    if (!buckets) {
      buckets = new Map();
      byProject.set(project, buckets);
    }
    const b = bucketFor(m.createdAt);
    let arr = buckets.get(b);
    if (!arr) {
      arr = [];
      buckets.set(b, arr);
    }
    arr.push(m);
  }

  const groups: ProjectGroup[] = [];
  for (const [project, bucketMap] of byProject) {
    let total = 0;
    const buckets: ProjectGroup["buckets"] = [];
    for (const b of BUCKETS) {
      const arr = bucketMap.get(b);
      if (!arr || arr.length === 0) continue;
      arr.sort(compareDesc);
      total += arr.length;
      buckets.push({ bucket: b, memories: arr });
    }
    groups.push({ project, total, buckets });
  }
  // Default project floats to the bottom; named projects sorted alphabetically.
  groups.sort((a, b) => {
    if (a.project === "default" && b.project !== "default") return 1;
    if (b.project === "default" && a.project !== "default") return -1;
    return a.project.localeCompare(b.project);
  });
  return groups;
}

export function SupermemoryStats({ query, forgetMemories }: Props) {
  const { data, isLoading, error, isFetching, dataUpdatedAt, refetch } = query;

  // Selection is a Set<id> across all projects. Cleared after each successful
  // forget; preserved across project filter changes (you might select in one
  // project, then switch to confirm).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);

  const projects = useMemo(() => {
    if (!data?.memories) return [] as string[];
    const seen = new Set<string>();
    for (const m of data.memories) seen.add(m.project || "default");
    return Array.from(seen).sort((a, b) => {
      if (a === "default" && b !== "default") return 1;
      if (b === "default" && a !== "default") return -1;
      return a.localeCompare(b);
    });
  }, [data?.memories]);

  const groups = useMemo(() => {
    if (!data?.memories) return [] as ProjectGroup[];
    const filtered = projectFilter
      ? data.memories.filter((m) => (m.project || "default") === projectFilter)
      : data.memories;
    return groupByProjectAndBucket(filtered);
  }, [data?.memories, projectFilter]);

  const visibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of groups) {
      for (const b of g.buckets) {
        for (const m of b.memories) ids.add(m.id);
      }
    }
    return ids;
  }, [groups]);

  const visibleSelectedCount = useMemo(() => {
    let count = 0;
    for (const id of selected) if (visibleIds.has(id)) count++;
    return count;
  }, [selected, visibleIds]);

  const allVisibleSelected =
    visibleIds.size > 0 && visibleSelectedCount === visibleIds.size;

  function toggleId(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setBucketSelection(memories: SupermemoryEntry[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of memories) {
        if (on) next.add(m.id);
        else next.delete(m.id);
      }
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      // If everything visible is already selected, clear visible only.
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  }

  function toggleProjectCollapsed(project: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      return next;
    });
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Failed to load supermemory usage:{" "}
        {error instanceof Error ? error.message : "unknown error"}
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
            Install the <strong>supermemory</strong> plugin and ask Claude Code
            to remember something (it'll call the{" "}
            <code className="text-xs">memory</code> tool).
          </p>
        </CardContent>
      </Card>
    );
  }

  const selectedIds = Array.from(selected);
  const selectedCount = selectedIds.length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          title="Saved Memories"
          value={
            <PrettyAmount
              amountFormatted={data.total}
              size="2xl"
              normalPrecision={0}
            />
          }
          icon={Brain}
        />
        <StatCard
          title="Dimension"
          value={
            <PrettyAmount
              amountFormatted={data.dimension ?? 0}
              size="2xl"
              normalPrecision={0}
            />
          }
          icon={Sparkles}
        />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base">Memories</CardTitle>
              <CardDescription>
                Newest {data.memories.length} of {data.total.toLocaleString()}{" "}
                memories on your API key, grouped by project and recency.
              </CardDescription>
            </div>
            <PluginFreshness
              dataUpdatedAt={dataUpdatedAt}
              isFetching={isFetching}
              onRefresh={() => refetch()}
            />
          </div>

          {projects.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <ProjectChip
                label={`All · ${data.memories.length}`}
                active={projectFilter === ""}
                onClick={() => setProjectFilter("")}
              />
              {projects.map((p) => {
                const count = data.memories.filter(
                  (m) => (m.project || "default") === p,
                ).length;
                return (
                  <ProjectChip
                    key={p}
                    label={`${p} · ${count}`}
                    active={projectFilter === p}
                    onClick={() => setProjectFilter(p)}
                  />
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 cursor-pointer rounded border-input"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) {
                    el.indeterminate =
                      visibleSelectedCount > 0 && !allVisibleSelected;
                  }
                }}
                onChange={toggleAllVisible}
                disabled={visibleIds.size === 0}
                aria-label="Select all visible memories"
              />
              {visibleSelectedCount > 0
                ? `${visibleSelectedCount} selected`
                : "Select all"}
            </label>

            {selectedCount > 0 && (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2 text-xs"
                  onClick={() => setConfirmOpen(true)}
                  disabled={forgetMemories.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  Forget {selectedCount}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelected(new Set())}
                  disabled={forgetMemories.isPending}
                >
                  <X className="mr-1 h-3 w-3" />
                  Clear
                </Button>
              </>
            )}
          </div>
        </CardHeader>

        <CardContent>
          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No memories in project <code>{projectFilter}</code>.
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map((g) => (
                <ProjectSection
                  key={g.project}
                  group={g}
                  collapsed={collapsed.has(g.project)}
                  onToggleCollapsed={() => toggleProjectCollapsed(g.project)}
                  selected={selected}
                  onToggleId={toggleId}
                  onToggleBucket={setBucketSelection}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!forgetMemories.isPending) setConfirmOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-[460px] w-[95vw] sm:w-full">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Forget {selectedCount}{" "}
              {selectedCount === 1 ? "memory" : "memories"}
            </DialogTitle>
            <DialogDescription>
              This permanently removes the selected{" "}
              {selectedCount === 1 ? "memory" : "memories"} from your store.
              The action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setConfirmOpen(false)}
              disabled={forgetMemories.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={selectedCount === 0 || forgetMemories.isPending}
              onClick={() => {
                forgetMemories.mutate(selectedIds, {
                  onSuccess: () => {
                    setSelected(new Set());
                    setConfirmOpen(false);
                  },
                });
              }}
            >
              {forgetMemories.isPending
                ? "Forgetting…"
                : `Forget ${selectedCount}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ProjectChipProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function ProjectChip({ label, active, onClick }: ProjectChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
        (active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-muted")
      }
    >
      {label}
    </button>
  );
}

interface ProjectSectionProps {
  group: ProjectGroup;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  selected: Set<string>;
  onToggleId: (id: string) => void;
  onToggleBucket: (memories: SupermemoryEntry[], on: boolean) => void;
}

function ProjectSection({
  group,
  collapsed,
  onToggleCollapsed,
  selected,
  onToggleId,
  onToggleBucket,
}: ProjectSectionProps) {
  const projectIds: string[] = [];
  for (const b of group.buckets) for (const m of b.memories) projectIds.push(m.id);
  const projectSelected = projectIds.filter((id) => selected.has(id)).length;
  const allProjectSelected =
    projectIds.length > 0 && projectSelected === projectIds.length;

  return (
    <section className="rounded-md border bg-muted/20">
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="flex items-center gap-1 text-sm font-medium text-foreground/90 hover:text-foreground"
          aria-expanded={!collapsed}
        >
          <ChevronRight
            className={
              "h-3.5 w-3.5 transition-transform " +
              (collapsed ? "" : "rotate-90")
            }
          />
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-mono uppercase tracking-wide text-primary">
            {group.project}
          </span>
          <span className="text-xs text-muted-foreground">
            {group.total} {group.total === 1 ? "memory" : "memories"}
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2">
          {projectSelected > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {projectSelected} selected
            </span>
          )}
          <input
            type="checkbox"
            className="h-3.5 w-3.5 cursor-pointer rounded border-input"
            checked={allProjectSelected}
            ref={(el) => {
              if (el) {
                el.indeterminate =
                  projectSelected > 0 && !allProjectSelected;
              }
            }}
            onChange={() => {
              const memories: SupermemoryEntry[] = [];
              for (const b of group.buckets) memories.push(...b.memories);
              onToggleBucket(memories, !allProjectSelected);
            }}
            aria-label={`Select all memories in project ${group.project}`}
          />
        </div>
      </header>

      {!collapsed && (
        <div className="space-y-2 px-3 pb-3">
          {group.buckets.map((b) => (
            <BucketSection
              key={b.bucket}
              bucket={b.bucket}
              memories={b.memories}
              selected={selected}
              onToggleId={onToggleId}
              onToggleBucket={onToggleBucket}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface BucketSectionProps {
  bucket: Bucket;
  memories: SupermemoryEntry[];
  selected: Set<string>;
  onToggleId: (id: string) => void;
  onToggleBucket: (memories: SupermemoryEntry[], on: boolean) => void;
}

function BucketSection({
  bucket,
  memories,
  selected,
  onToggleId,
  onToggleBucket,
}: BucketSectionProps) {
  const selectedHere = memories.filter((m) => selected.has(m.id)).length;
  const allSelected = selectedHere === memories.length;

  return (
    <div>
      <div className="flex items-center gap-2 pb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <input
          type="checkbox"
          className="h-3 w-3 cursor-pointer rounded border-input"
          checked={allSelected}
          ref={(el) => {
            if (el) {
              el.indeterminate = selectedHere > 0 && !allSelected;
            }
          }}
          onChange={() => onToggleBucket(memories, !allSelected)}
          aria-label={`Select all in ${bucket}`}
        />
        <span>{bucket}</span>
        <span className="text-muted-foreground/70">· {memories.length}</span>
      </div>
      <ul className="space-y-1.5">
        {memories.map((m) => (
          <li
            key={m.id}
            className={
              "rounded-md border p-2.5 text-sm transition-colors " +
              (selected.has(m.id)
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-background")
            }
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer rounded border-input"
                checked={selected.has(m.id)}
                onChange={() => onToggleId(m.id)}
                aria-label="Select memory"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <p className="flex-1 whitespace-pre-wrap break-words leading-relaxed">
                    {m.content.length > 400
                      ? `${m.content.slice(0, 400)}…`
                      : m.content}
                  </p>
                  {m.createdAt ? (
                    <PrettyDate
                      date={m.createdAt}
                      format="relative"
                      size="xs"
                      className="shrink-0 text-xs text-muted-foreground"
                    />
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      —
                    </span>
                  )}
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span className="font-mono">{m.id}</span>
                  {m.source ? <span>· {m.source}</span> : null}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
