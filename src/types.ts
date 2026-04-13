export type SDKMessage =
  | { type: 'system'; subtype: 'init'; session_id: string; [key: string]: any }
  | { type: 'assistant'; message: { content: Array<{ type: string; text?: string; name?: string; input?: any; [key: string]: any }> }; [key: string]: any }
  | { type: 'result'; subtype: 'success' | string; result?: string; total_cost_usd?: number; duration_ms?: number; [key: string]: any }
  | { type: 'user'; [key: string]: any }
  | { type: string; [key: string]: any };

export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}