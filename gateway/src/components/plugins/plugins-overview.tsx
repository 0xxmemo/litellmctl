import { useState } from "react";
import { FolderTree, Brain } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaudeContextStats } from "./claude-context-stats";
import { DocsContextStats } from "./docs-context-stats";
import { SupermemoryStats } from "./supermemory-stats";
import {
  useClaudeContextUsage,
  useSupermemoryUsage,
  useRemoveClaudeContextCodebase,
  useStopClaudeContextJob,
  useClearClaudeContextJob,
  useHideClaudeContextCodebase,
  useUnhideClaudeContextCodebase,
  useDocsContextUsage,
  useRemoveDocsContextSource,
  useStopDocsContextJob,
  useClearDocsContextJob,
  useHideDocsContextSource,
  useUnhideDocsContextSource,
} from "@/hooks/use-plugins";

interface Props {
  enabled: boolean;
  isAdmin: boolean;
}

export function PluginsOverview({ enabled, isAdmin }: Props) {
  const [active, setActive] = useState<string>("claude-context");
  const claudeContextQuery = useClaudeContextUsage({ enabled });
  const docsContextQuery = useDocsContextUsage({ enabled });
  const supermemoryQuery = useSupermemoryUsage(20, { enabled });
  const removeCodebase = useRemoveClaudeContextCodebase();
  const stopJob = useStopClaudeContextJob();
  const clearJob = useClearClaudeContextJob();
  const hideCodebase = useHideClaudeContextCodebase();
  const unhideCodebase = useUnhideClaudeContextCodebase();
  const removeDocsSource = useRemoveDocsContextSource();
  const stopDocsJob = useStopDocsContextJob();
  const clearDocsJob = useClearDocsContextJob();
  const hideDocsSource = useHideDocsContextSource();
  const unhideDocsSource = useUnhideDocsContextSource();

  return (
    <Tabs value={active} onValueChange={setActive} className="w-full">
      <TabsList className="grid w-full grid-cols-2 max-w-md">
        <TabsTrigger value="claude-context" className="gap-1.5">
          <FolderTree className="h-4 w-4" />
          claude-context
        </TabsTrigger>
        <TabsTrigger value="supermemory" className="gap-1.5">
          <Brain className="h-4 w-4" />
          supermemory
        </TabsTrigger>
      </TabsList>

      <TabsContent value="claude-context" className="mt-4 space-y-6">
        <ClaudeContextStats
          query={claudeContextQuery}
          isAdmin={isAdmin}
          removeCodebase={removeCodebase}
          stopJob={stopJob}
          clearJob={clearJob}
          hideCodebase={hideCodebase}
          unhideCodebase={unhideCodebase}
        />
        <DocsContextStats
          query={docsContextQuery}
          isAdmin={isAdmin}
          removeSource={removeDocsSource}
          stopJob={stopDocsJob}
          clearJob={clearDocsJob}
          hideSource={hideDocsSource}
          unhideSource={unhideDocsSource}
        />
      </TabsContent>

      <TabsContent value="supermemory" className="mt-4">
        <SupermemoryStats query={supermemoryQuery} />
      </TabsContent>
    </Tabs>
  );
}
