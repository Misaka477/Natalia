export interface ToolCall {
  name: string;
  output?: string;
  status?: string;
  summary?: string;
}

export interface MessageAction {
  label: string;
  primary?: boolean;
  onClick: () => void;
}

export interface Attachment {
  id?: string;
  path: string;
  name: string;
  mediaType?: string;
  width?: number;
  height?: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  status?: "running" | "completed" | "error" | "done" | "failed";
  /** A user input injected into a running turn rather than starting one. */
  steering?: boolean;
  thinking?: boolean;
  streaming?: boolean;
  /**
   * A goal round (`<goal_round>` internal turn). The transcript renders it as a
   * compact `Round N/M` row with the full prompt behind a disclosure.
   */
  goalRound?: {
    round: number;
    maxGoalRounds: number;
    objective: string;
    detail: string;
  };
  toolCalls?: ToolCall[];
  actions?: MessageAction[];
  attachments?: Attachment[];
}
