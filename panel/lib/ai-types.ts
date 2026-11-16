/* Shared between the AI agent on the server (lib/agent.ts) and the chat UI. */

/** "ask": commands and file writes wait for approval. "auto": they run straight away. */
export type AiMode = "ask" | "auto";

export type ToolName = "run_command" | "read_file" | "write_file";

export type ToolStatus = "queued" | "approval" | "running" | "done" | "error" | "denied";

export type ChatEvent =
  | { k: "user"; id: string; at: number; text: string }
  | { k: "text"; id: string; at: number; text: string }
  | {
      k: "tool";
      id: string;
      at: number;
      tool: ToolName;
      machine: string;
      /** run_command: the command; read/write_file: the path. */
      summary: string;
      /** write_file: the new contents. */
      content?: string;
      status: ToolStatus;
      output: string;
      exitCode: number | null;
      ms: number | null;
      /** Why it was denied, or the error. */
      note?: string;
    }
  | { k: "error"; id: string; at: number; text: string }
  | { k: "done"; id: string; at: number; costUsd: number; ms: number; turns: number; stopped?: boolean };

export type ChatStatus = "idle" | "running" | "approval";

export interface ChatSummary {
  id: string;
  title: string;
  node: string;
  mode: AiMode;
  status: ChatStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Chat extends ChatSummary {
  events: ChatEvent[];
}

export type AiClientMsg =
  | { t: "list" }
  | { t: "open"; chat: string }
  | { t: "new"; node: string; mode: AiMode; text: string; nonce: string }
  | { t: "send"; chat: string; text: string }
  | { t: "approve"; chat: string; tool: string; allow: boolean; note?: string; always?: boolean }
  | { t: "stop"; chat: string }
  | { t: "update"; chat: string; mode?: AiMode; node?: string }
  | { t: "delete"; chat: string };

export type AiServerMsg =
  | { t: "hello"; model: string; ready: boolean; error: string | null }
  | { t: "chats"; list: ChatSummary[] }
  | { t: "chat"; chat: Chat }
  | { t: "created"; nonce: string; chat: string }
  | { t: "event"; chat: string; event: ChatEvent }
  | { t: "delta"; chat: string; id: string; text: string }
  | { t: "error"; message: string };
