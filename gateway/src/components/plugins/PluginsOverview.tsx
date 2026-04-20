import { useState } from "react";
import { FolderTree, Brain } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaudeContextStats } from "./ClaudeContextStats";
import { SupermemoryStats } from "./SupermemoryStats";
import { useClaudeContextUsage, useSupermemoryUsage } from "@/hooks/usePlugins";

interface Props {
  enabled: boolean;
}

export function PluginsOverview({ enabled }: Props) {
  const [active, setActive] = useState<string>("claude-context");
  const claudeContextQuery = useClaudeContextUsage({ enabled });
  const supermemoryQuery = useSupermemoryUsage(20, { enabled });

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

      <TabsContent value="claude-context" className="mt-4">
        <ClaudeContextStats query={claudeContextQuery} />
      </TabsContent>

      <TabsContent value="supermemory" className="mt-4">
        <SupermemoryStats query={supermemoryQuery} />
      </TabsContent>
    </Tabs>
  );
}
