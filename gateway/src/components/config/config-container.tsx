import { useState } from "react";
import { Key, Download, Puzzle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiKeyInput, useApiKey } from "@/components/endpoint-try-card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SetupWidget } from "./setup-widget";
import { SkillsInstall } from "./skills-install";
import { PluginsInstall } from "./plugins-install";

function getBaseUrl(): string {
  if (typeof window === "undefined") return "http://localhost:14041";
  return `${window.location.protocol}//${window.location.host}`;
}

export function ConfigContainer() {
  const { apiKey, setApiKey } = useApiKey();
  const baseUrl = getBaseUrl();
  const [activeTab, setActiveTab] = useState("setup");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Key className="h-5 w-5" />
          Configure Your Client
        </CardTitle>
        <CardDescription>
          Set up your API key and install client integrations
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* API Key Input - Always visible */}
        <div className="mb-4">
          <ApiKeyInput apiKey={apiKey} onChange={setApiKey} />
          {!apiKey && (
            <p className="text-xs text-muted-foreground mt-2">
              Get your key from the <strong>API Keys</strong> tab. It's stored only in your browser.
            </p>
          )}
        </div>

        {/* Tabs for different setup options */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="setup" className="gap-1.5">
              Setup
            </TabsTrigger>
            <TabsTrigger value="skills" className="gap-1.5">
              <Download className="h-4 w-4" />
              Skills
            </TabsTrigger>
            <TabsTrigger value="plugins" className="gap-1.5">
              <Puzzle className="h-4 w-4" />
              Plugins
            </TabsTrigger>
          </TabsList>

          <TabsContent value="setup" className="mt-4">
            <SetupWidget apiKey={apiKey} baseUrl={baseUrl} />
          </TabsContent>

          <TabsContent value="skills" className="mt-4">
            <SkillsInstall apiKey={apiKey} baseUrl={baseUrl} />
          </TabsContent>

          <TabsContent value="plugins" className="mt-4">
            <PluginsInstall apiKey={apiKey} baseUrl={baseUrl} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
