import { useState, useEffect } from "react";
import { Check } from "lucide-react";
import { CopyButton } from "./copy-button";
import { useSetupOptions } from "@/hooks/useSetup";

const KEY_PLACEHOLDER = "YOUR_API_KEY";

export interface SetupWidgetProps {
  apiKey: string;
  baseUrl: string;
}

export function SetupWidget({ apiKey, baseUrl }: SetupWidgetProps) {
  const { data: options = [], isLoading } = useSetupOptions();
  const [selectedOption, setSelectedOption] = useState<string>("");

  // Set default selection when options load
  useEffect(() => {
    if (options.length > 0 && !selectedOption) {
      setSelectedOption(options[0].id);
    }
  }, [options, selectedOption]);

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : options.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No setup options available.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Setup Option Selector */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Setup Option
            </label>
            <select
              value={selectedOption}
              onChange={(e) => setSelectedOption(e.target.value)}
              className="glass glass--outline gateway-select"
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>

          {options.map((option) => {
            if (option.id !== selectedOption) return null;

            const installUrl = `${baseUrl}${option.scriptUrl}`;
            const installCmd = `curl -fsSL ${installUrl} | ${option.configVar}="${KEY_PLACEHOLDER}" bash`;

            return (
              <div key={option.id} className="space-y-3">
                {/* Command */}
                <div className="rounded-lg border border-border/50 bg-muted/35 p-4 backdrop-blur-md dark:border-white/5">
                  <div className="flex items-center justify-between gap-4">
                    <code className="text-xs break-all font-mono text-muted-foreground select-all">
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
                </div>

                {/* API Key Status */}
                {apiKey ? (
                  <p className="text-xs text-ui-success-fg flex items-center gap-1">
                    <Check className="h-3.5 w-3.5" />
                    API key will be substituted on copy
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Enter your API key above — it will be substituted when you copy.
                  </p>
                )}

                {/* Features */}
                <ul className="text-xs text-muted-foreground space-y-1 list-none pl-1">
                  {option.features.map((feature, idx) => (
                    <li key={idx}>• {feature}</li>
                  ))}
                </ul>

                {/* Requirements */}
                <p className="text-xs text-muted-foreground">
                  Requires: {option.requirements.join(", ")}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
