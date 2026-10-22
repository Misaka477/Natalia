export type {
  Attachment,
  Message,
  MessageAction,
  ToolCall,
} from "@natalia/ui-kit";

export interface NavSession {
  id: string;
  title: string;
  state: "idle" | "running" | "error";
  active?: boolean;
}

export interface NavWorkspace {
  id: string;
  name: string;
  sessions: NavSession[];
}
