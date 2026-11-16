import { Fragment } from "react";

/** Renders the tiny subset of markdown notes use inline: `code`, **bold**, links. */
export function Md({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)`]+)/g);
  return (
    <span className={className}>
      {parts.map((p, i) => {
        if (p.startsWith("`") && p.endsWith("`"))
          return (
            <code key={i} className="rounded bg-cyan/[0.08] px-1 py-px font-mono text-[0.88em] whitespace-nowrap text-cyan/90">
              {p.slice(1, -1)}
            </code>
          );
        if (p.startsWith("**") && p.endsWith("**"))
          return (
            <strong key={i} className="font-semibold text-fg">
              {p.slice(2, -2)}
            </strong>
          );
        if (/^https?:\/\//.test(p))
          return (
            <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-blue underline decoration-blue/50 decoration-dotted underline-offset-[3px] hover:decoration-solid">
              {p.replace(/^https?:\/\//, "")}
            </a>
          );
        return <Fragment key={i}>{p}</Fragment>;
      })}
    </span>
  );
}
