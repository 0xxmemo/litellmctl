import { useState } from "react";
import { Check } from "lucide-react";
import { CopyButton } from "./CopyButton";
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
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
              const configVar =
                targets.find((t) => t.id === selectedTarget)?.configVar || "LLM_GATEWAY_API_KEY";
              const installCmd = `curl -fsSL ${installUrl} | ${configVar}="${KEY_PLACEHOLDER}" bash`;
              return (
                <div key={skill.slug} className="rounded-md border bg-muted/40 p-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-semibold">{skill.name}</h4>
                      <p className="text-xs text-muted-foreground mt-1">{skill.description}</p>
                    </div>
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
              );
            })}
          </div>
        )}
    </div>
  );
}
