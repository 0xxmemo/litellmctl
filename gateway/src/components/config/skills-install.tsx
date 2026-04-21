import { useState } from "react";
import { Check, Download, Trash2 } from "lucide-react";
import { CopyButton } from "./copy-button";
import { useSkills, useInstallTargets } from "@/hooks/useSkills";

const KEY_PLACEHOLDER = "YOUR_API_KEY";

export interface SkillsInstallProps {
  apiKey: string;
  baseUrl: string;
}

export function SkillsInstall({ apiKey, baseUrl }: SkillsInstallProps) {
  const { data: skills = [], isLoading: skillsLoading } = useSkills();
  const { data: targets = [], isLoading: targetsLoading } = useInstallTargets();
  const [selectedTarget, setSelectedTarget] = useState<string>("claude-code");
  const [showUninstall, setShowUninstall] = useState<Record<string, boolean>>({});

  const toggleUninstall = (slug: string) => {
    setShowUninstall((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  return (
    <div className="space-y-3">
        {skillsLoading || targetsLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No skills available. Add a skill by creating a directory with a{" "}
            <code className="text-xs">SKILL.md</code> file in{" "}
            <code className="text-xs">skills/</code>.
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
                className="glass glass--outline gateway-select"
              >
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Skills will be installed to:{" "}
                <code className="text-xs">
                  {targets.find((t) => t.id === selectedTarget)?.skillsDir || "~/.litellm/skills"}
                </code>
              </p>
            </div>

            {skills.map((skill) => {
              const installUrl = `${baseUrl}/api/skills/install.sh?slug=${skill.slug}&target=${selectedTarget}`;
              const uninstallUrl = `${baseUrl}/api/skills/uninstall.sh?slug=${skill.slug}&target=${selectedTarget}`;
              // TODO: default to LITELLMCTL_API_KEY after migration from LLM_GATEWAY_API_KEY.
              const configVar =
                targets.find((t) => t.id === selectedTarget)?.configVar || "LLM_GATEWAY_API_KEY";
              const installCmd = `curl -fsSL ${installUrl} | ${configVar}="${KEY_PLACEHOLDER}" bash`;
              const uninstallCmd = `curl -fsSL ${uninstallUrl} | bash`;
              const isUninstallVisible = showUninstall[skill.slug] ?? false;

              return (
                <div key={skill.slug} className="space-y-3 rounded-lg border border-border/50 bg-muted/35 p-4 backdrop-blur-md dark:border-white/5">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-semibold">{skill.name}</h4>
                      <p className="text-xs text-muted-foreground mt-1">{skill.description}</p>
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
                      onClick={() => toggleUninstall(skill.slug)}
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
