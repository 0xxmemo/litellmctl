import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface CopyButtonProps {
  text: string;
  substitutions?: Record<string, string>;
  className?: string;
  label?: string;
}

export function CopyButton({
  text,
  substitutions,
  className,
  label,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      let content = text;
      if (substitutions) {
        for (const [placeholder, value] of Object.entries(substitutions)) {
          content = content.split(placeholder).join(value);
        }
      }
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* fallback: do nothing */
    }
  };

  if (label) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={`gap-1.5 text-xs ${className ?? ""}`}
        onClick={handleCopy}
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5 text-green-500" /> Copied!
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" /> {label}
          </>
        )}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className={`h-7 w-7 ${className ?? ""}`}
      onClick={handleCopy}
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
