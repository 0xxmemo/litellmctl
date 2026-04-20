import { useState } from "react";
import { Check, Download, Trash2 } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { usePlugins, usePluginTargets } from "@/hooks/usePlugins";

const KEY_PLACEHOLDER = "YOUR_API_KEY";

export interface PluginsInstallProps {
  apiKey: string;
  baseUrl: string;
}

export function PluginsInstall({ apiKey, baseUrl }: PluginsInstallProps) {
  const { data: plugins = [], isLoading: pluginsLoading } = usePlugins();
  const { data: targets = [], isLoading: targetsLoading } = usePluginTargets();
  const [selectedTarget, setSelectedTarget] = useState<string>("claude-code");
  const [showUninstall, setShowUninstall] = useState<Record<string, boolean>>({});

  const toggleUninstall = (slug: string) => {
    setShowUninstall((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  return (
    <div className="space-y-3">
      {pluginsLoading || targetsLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : plugins.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No plugins available. Add a plugin by creating a directory with a{" "}
          <code className="text-xs">PLUGIN.md</code> file in{" "}
          <code className="text-xs">plugins/</code>.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Target Platform Selector */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Target Platform
            </label>
            <select
              value={selectedTarget}
              onChange={(e) => setSelectedTarget(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Plugins register an MCP server in:{" "}
              <code className="text-xs">
                {targets.find((t) => t.id === selectedTarget)?.settingsDir || "~/.claude"}
              </code>
              /settings.json
            </p>
          </div>

          {plugins.map((plugin) => {
            const installUrl = `${baseUrl}/api/plugins/install.sh?slug=${plugin.slug}&target=${selectedTarget}`;
            const uninstallUrl = `${baseUrl}/api/plugins/uninstall.sh?slug=${plugin.slug}&target=${selectedTarget}`;
            const configVar =
              targets.find((t) => t.id === selectedTarget)?.configVar || "LLM_GATEWAY_API_KEY";
            const installCmd = `curl -fsSL ${installUrl} | ${configVar}="${KEY_PLACEHOLDER}" bash`;
            const uninstallCmd = `curl -fsSL ${uninstallUrl} | bash`;
            const isUninstallVisible = showUninstall[plugin.slug] ?? false;

            return (
              <div key={plugin.slug} className="rounded-md border bg-muted/40 p-4 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold">{plugin.name}</h4>
                      <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                        {plugin.type || "mcp"}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{plugin.description}</p>
                  </div>
                </div>

                {/* Install command */}
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <Download className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs font-medium text-muted-foreground">Install</span>
                  </div>
                  <div className="flex items-center gap-4">
                    <code className="text-xs break-all font-mono text-muted-foreground select-all flex-1">
                      {installCmd}
                    </code>
                    <div className="shrink-0">
                      <CopyButton
                        text={installCmd}
                        substitutions={
                          apiKey ? { [KEY_PLACEHOLDER]: apiKey } : undefined
                        }
                        label="Copy"
                      />
                    </div>
                  </div>
                  {apiKey ? (
                    <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                      <Check className="h-3.5 w-3.5" />
                      API key will be substituted on copy
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Enter your API key above — it will be substituted when you copy.
                    </p>
                  )}
                </div>

                {/* Uninstall toggle + command */}
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => toggleUninstall(plugin.slug)}
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0" />
                    <span>{isUninstallVisible ? "Hide uninstall" : "Uninstall"}</span>
                  </button>
                  {isUninstallVisible && (
                    <div className="flex items-center gap-4 mt-1">
                      <code className="text-xs break-all font-mono text-muted-foreground select-all flex-1">
                        {uninstallCmd}
                      </code>
                      <div className="shrink-0">
                        <CopyButton text={uninstallCmd} label="Copy" />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
