import clsx from "clsx";
import { Fragment, type ReactNode } from "react";

/** Inline markdown: `code`, **bold**, *italic*, [links](url) and bare URLs. */
function inline(text: string, key = ""): ReactNode[] {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|(?<![\w*])\*[^*\n]+\*(?![\w*])|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()`]+[^\s<>()`.,;:!?'"])/g);
  return parts.map((p, i) => {
    const k = `${key}${i}`;
    if (!p) return null;
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1)
      return (
        <code key={k} className="rounded bg-cyan/[0.08] px-1 py-px font-mono text-[0.88em] break-words text-cyan/90">
          {p.slice(1, -1)}
        </code>
      );
    if (p.startsWith("**") && p.endsWith("**"))
      return (
        <strong key={k} className="font-semibold text-fg">
          {inline(p.slice(2, -2), k)}
        </strong>
      );
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return <em key={k}>{p.slice(1, -1)}</em>;
    const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    const url = link ? link[2] : /^https?:\/\//.test(p) ? p : null;
    if (url)
      return (
        <a key={k} href={url} target="_blank" rel="noopener noreferrer" className="text-blue underline decoration-blue/50 decoration-dotted underline-offset-[3px] hover:decoration-solid">
          {link ? link[1] : p.replace(/^https?:\/\//, "")}
        </a>
      );
    return <Fragment key={k}>{p}</Fragment>;
  });
}

type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "rule" }
  | { type: "p"; text: string };

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function parse(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const close = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming block)
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push({ type: "table", head, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (m) {
          items.push(m[2]);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i++;
        } else break;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !(lines[i].trim().startsWith("|") && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? ""))
    )
      body.push(lines[i++]);
    blocks.push({ type: "p", text: body.join("\n") });
  }
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parse(text);
  return (
    <div className={clsx("space-y-2.5 text-[14px] leading-[1.6] text-fg-2 [overflow-wrap:anywhere]", className)}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-lg border border-line bg-void/70 px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-fg-2 [overflow-wrap:normal]">
                {b.text}
              </pre>
            );
          case "heading":
            return (
              <div key={i} className={clsx("pt-1 font-semibold text-fg", b.level <= 2 ? "text-[15.5px]" : "text-[14.5px]")}>
                {inline(b.text)}
              </div>
            );
          case "rule":
            return <hr key={i} className="border-line-2" />;
          case "quote":
            return (
              <blockquote key={i} className="border-l-2 border-line-3 pl-3 whitespace-pre-line text-fg-3">
                {inline(b.text)}
              </blockquote>
            );
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={clsx("space-y-1 pl-5", b.ordered ? "list-decimal marker:text-fg-4" : "list-disc marker:text-fg-5")}>
                {b.items.map((it, j) => (
                  <li key={j} className="pl-0.5 whitespace-pre-line">
                    {inline(it, `${j}-`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-[13px]">
                  <thead className={clsx("bg-raised/60 text-fg", b.head.every((h) => !h) && "hidden")}>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} className="px-3 py-1.5 font-semibold whitespace-nowrap">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j} className={clsx("border-line", (j > 0 || b.head.some((h) => h)) && "border-t")}>
                        {r.map((c, k) => (
                          <td key={k} className="px-3 py-1.5 align-top">
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "p":
            return (
              <p key={i} className="whitespace-pre-line">
                {inline(b.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
