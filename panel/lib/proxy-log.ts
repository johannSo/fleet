/**
 * Parses CLIProxyAPI request logs (`request-log: true`): one text file per request with
 * `=== SECTION ===` blocks for the client request, each upstream attempt and the
 * response sent back. Pure functions, used by the server (lib/proxy-capture.ts) and by
 * the Traffic page to split a raw log into sections.
 */

export interface LogSection {
  /** "REQUEST INFO", "HEADERS", "REQUEST BODY", "API REQUEST 1", "API RESPONSE 1", "API ERROR RESPONSE", "RESPONSE", … */
  name: string;
  body: string;
}

const SECTION_RE = /^=== (REQUEST INFO|HEADERS|REQUEST BODY|API REQUEST(?: \d+)?|API RESPONSE(?: \d+)?|API ERROR RESPONSE|RESPONSE|WEBSOCKET TIMELINE|API WEBSOCKET TIMELINE)(?: [^=\n]*)? ===$/;

export function splitSections(raw: string): LogSection[] {
  const out: LogSection[] = [];
  let cur: LogSection | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) out.push({ name: cur.name, body: buf.join("\n").replace(/\n+$/, "") });
  };
  for (const line of raw.split("\n")) {
    const m = line.match(SECTION_RE);
    if (m) {
      flush();
      cur = { name: m[1], body: "" };
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** `Key: value` lines up to the first blank line; returns them and the rest (the body). */
export function headerBlock(text: string): { headers: [string, string][]; rest: string } {
  const headers: [string, string][] = [];
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) break;
    const c = l.indexOf(":");
    if (c > 0) headers.push([l.slice(0, c).trim(), l.slice(c + 1).trim()]);
  }
  return { headers, rest: lines.slice(i + 1).join("\n").trim() };
}

/** An upstream attempt section: `Timestamp`, `Upstream URL`, `Auth`, then `Headers:` and `Body:`. */
export function attemptParts(text: string): { meta: [string, string][]; headers: [string, string][]; body: string } {
  const hi = text.indexOf("\nHeaders:\n");
  const bi = text.indexOf("\nBody:\n");
  const metaEnd = hi >= 0 ? hi : bi >= 0 ? bi : text.length;
  const meta = headerBlock(text.slice(0, metaEnd) + "\n").headers;
  const headers = hi >= 0 ? headerBlock(text.slice(hi + 10, bi > hi ? bi : undefined) + "\n").headers : [];
  const body = bi >= 0 ? text.slice(bi + 7).trim() : "";
  return { meta, headers, body };
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Text of a message `content` in Anthropic, OpenAI chat, Responses or Gemini shape. */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  const parts: string[] = [];
  for (const b of arr(c)) {
    const o = obj(b);
    const t = s(o.type);
    if (s(o.text)) parts.push(s(o.text));
    else if (t === "tool_result") parts.push(`[tool result] ${contentText(o.content)}`);
    else if (t === "tool_use" || t === "function_call") parts.push(`[tool: ${s(o.name)}]`);
    else if (t === "image" || t === "image_url" || t === "input_image") parts.push("[image]");
    else if (o.functionResponse) parts.push(`[tool result] ${s(obj(o.functionResponse).name)}`);
    else if (o.functionCall) parts.push(`[tool: ${s(obj(o.functionCall).name)}]`);
  }
  return parts.join("\n");
}

/** The last user turn of a request body, for a one-line preview. */
export function promptOf(body: string): string {
  const d = obj(parseJson(body));
  if (typeof d.input === "string") return d.input;
  const lists: unknown[][] = [arr(d.messages), arr(d.input), arr(d.contents)];
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = obj(list[i]);
      if (m.role !== "user") continue;
      const full = contentText(m.content ?? m.parts).trim();
      // Clients like Claude Code prepend injected context; show what the person typed.
      const t = full.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || full;
      if (t) return t;
    }
  }
  if (typeof d.prompt === "string") return d.prompt;
  return "";
}

interface Usage {
  input: number;
  output: number;
}

function usageFrom(o: J, u: Usage) {
  const walk = (v: unknown, depth: number) => {
    if (depth > 4) return;
    const x = obj(v);
    for (const key of ["usage", "usageMetadata"]) {
      const us = obj(x[key]);
      if (!Object.keys(us).length) continue;
      const inp = n(us.input_tokens) + n(us.cache_read_input_tokens) + n(us.cache_creation_input_tokens) || n(us.prompt_tokens) || n(us.promptTokenCount);
      const out = n(us.output_tokens) || n(us.completion_tokens) || n(us.candidatesTokenCount);
      if (inp > u.input) u.input = inp;
      if (out > u.output) u.output = out;
    }
    for (const key of ["message", "response"]) if (x[key]) walk(x[key], depth + 1);
  };
  walk(o, 0);
}

/** The answer text and token counts in a response body: JSON, or a server-sent event stream. */
export function answerOf(body: string): { text: string; input: number; output: number } {
  const u: Usage = { input: 0, output: 0 };
  const t = body.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const d = parseJson(t);
    const items = Array.isArray(d) ? d : [d];
    const parts: string[] = [];
    for (const it of items) {
      const o = obj(it);
      usageFrom(o, u);
      if (o.content) parts.push(contentText(o.content));
      for (const c of arr(o.choices)) {
        const m = obj(obj(c).message);
        if (m.content) parts.push(contentText(m.content));
        for (const tc of arr(m.tool_calls)) parts.push(`[tool: ${s(obj(obj(tc).function).name)}]`);
      }
      for (const out of arr(o.output)) {
        const oo = obj(out);
        if (oo.type === "function_call") parts.push(`[tool: ${s(oo.name)}]`);
        else if (oo.content) parts.push(contentText(oo.content));
      }
      for (const c of arr(o.candidates)) parts.push(contentText(obj(obj(c).content).parts));
      const err = s(o.error) || s(obj(o.error).message);
      if (err) parts.push(`[error] ${err}`);
    }
    return { text: parts.filter(Boolean).join("\n"), ...u };
  }
  // Server-sent events: concatenate the deltas.
  let text = "";
  for (const line of t.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const o = obj(parseJson(payload));
    usageFrom(o, u);
    const type = s(o.type);
    if (type === "content_block_delta") text += s(obj(o.delta).text);
    else if (type === "content_block_start" && obj(o.content_block).type === "tool_use") text += `\n[tool: ${s(obj(o.content_block).name)}]\n`;
    else if (type === "response.output_text.delta") text += s(o.delta);
    else if (type === "response.output_item.added" && obj(o.item).type === "function_call") text += `\n[tool: ${s(obj(o.item).name)}]\n`;
    else if (type === "error") text += `\n[error] ${s(obj(o.error).message)}`;
    for (const c of arr(o.choices)) {
      const d = obj(obj(c).delta);
      text += s(d.content);
      for (const tc of arr(d.tool_calls)) if (s(obj(obj(tc).function).name)) text += `\n[tool: ${s(obj(obj(tc).function).name)}]\n`;
    }
    for (const c of arr(o.candidates)) text += contentText(obj(obj(c).content).parts);
  }
  return { text: text.trim(), ...u };
}

export interface ParsedLog {
  ts: number;
  url: string;
  method: string;
  status: number;
  model: string;
  stream: boolean;
  provider: string;
  account: string;
  attempts: number;
  userAgent: string;
  key: string;
  requestId: string;
  prompt: string;
  answer: string;
  input: number;
  output: number;
}

const header = (hs: [string, string][], name: string) => hs.find(([k]) => k.toLowerCase() === name)?.[1] ?? "";

export function parseLog(raw: string): ParsedLog {
  const secs = splitSections(raw);
  const get = (name: string) => secs.find((x) => x.name === name)?.body ?? "";
  const info = headerBlock(get("REQUEST INFO") + "\n").headers;
  const reqHeaders = headerBlock(get("HEADERS") + "\n").headers;
  const reqBody = get("REQUEST BODY").trim();
  const attempts = secs.filter((x) => x.name.startsWith("API REQUEST"));
  const responses = secs.filter((x) => x.name.startsWith("API RESPONSE"));
  const last = attempts.at(-1) ? attemptParts(attempts.at(-1)!.body) : null;
  const auth = last ? header(last.meta, "auth") : "";
  const authField = (k: string) => auth.match(new RegExp(`(?:^|,\\s*)${k}=([^,]*)`))?.[1]?.trim() ?? "";

  const url = header(info, "url");
  const reqJson = obj(parseJson(reqBody));
  const model = s(reqJson.model) || url.match(/\/models\/([^/:?]+)/)?.[1] || "";

  let status = 0;
  let answerBody = "";
  const resp = secs.find((x) => x.name === "RESPONSE");
  if (resp) {
    const lines = resp.body.split("\n");
    status = Number(lines[0]?.match(/^Status:\s*(\d+)/)?.[1] ?? 0);
    answerBody = headerBlock(lines.slice(1).join("\n")).rest;
  }
  const lastResp = responses.at(-1);
  if (lastResp) {
    const p = attemptParts(lastResp.body);
    if (!status) status = Number(lastResp.body.match(/^Status:\s*(\d+)/m)?.[1] ?? 0);
    if (!answerBody) answerBody = p.body;
  }
  const err = secs.filter((x) => x.name === "API ERROR RESPONSE").at(-1);
  if (!status && err) status = Number(err.body.match(/^HTTP Status:\s*(\d+)/m)?.[1] ?? 0);

  const ans = answerOf(answerBody);
  // Upstream usage is the most reliable when the client response was translated.
  const upstream = lastResp ? answerOf(attemptParts(lastResp.body).body) : { input: 0, output: 0 };
  const respHeaders = resp ? headerBlock(resp.body.split("\n").slice(1).join("\n")).headers : [];
  const trace = header(respHeaders, "x-cpa-trace-id");
  const ts = Date.parse(header(info, "timestamp"));

  return {
    ts: Number.isFinite(ts) ? ts : 0,
    url,
    method: header(info, "method"),
    status,
    model,
    stream: reqJson.stream === true || /stream/i.test(url) || /^(event|data):/m.test(answerBody),
    provider: authField("provider"),
    account: authField("label") || authField("auth_id"),
    attempts: attempts.length,
    userAgent: header(reqHeaders, "user-agent"),
    key: header(reqHeaders, "authorization").replace(/^Bearer\s+/i, "") || header(reqHeaders, "x-api-key") || header(reqHeaders, "x-goog-api-key"),
    requestId: trace.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)?.[1] ?? "",
    prompt: promptOf(reqBody),
    answer: ans.text || (err ? err.body.split("\n").slice(1).join("\n").trim() : ""),
    input: Math.max(ans.input, upstream.input),
    output: Math.max(ans.output, upstream.output),
  };
}
