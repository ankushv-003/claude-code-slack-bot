import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join, resolve } from 'path';
import { ConversationSession, SDKMessage } from './types';
import { Logger } from './logger';
import { McpManager } from './mcp-manager';
import { config } from './config';

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string }
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const ctrl = abortController || new AbortController();

    // Build CLI args
    const args: string[] = ['--output-format', 'stream-json', '--verbose'];

    if (config.claude.model) {
      args.push('--model', config.claude.model);
    }

    // bypassPermissions when no Slack context (e.g. direct API use)
    if (!slackContext) {
      args.push('--permission-mode', 'bypassPermissions');
    }

    if (slackContext) {
      args.push('--permission-prompt-tool', 'mcp__permission-prompt__permission_prompt');
    }

    // MCP servers
    const mcpServers = this.mcpManager.getServerConfiguration();
    const allMcpServers: Record<string, any> = mcpServers ? { ...mcpServers } : {};

    if (slackContext) {
      const scriptPath = resolve(process.cwd(), 'src', 'permission-mcp-server.ts');
      allMcpServers['permission-prompt'] = {
        command: 'npx',
        args: ['tsx', scriptPath],
        env: {
          SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
          SLACK_CONTEXT: JSON.stringify(slackContext),
        },
      };
    }

    if (Object.keys(allMcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: allMcpServers }));

      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext) {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0) {
        args.push('--allowedTools', defaultMcpTools.join(','));
      }
    }

    if (session?.sessionId) {
      args.push('--resume', session.sessionId);
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    args.push('--print', prompt.trim());

    // Resolve CLI path
    let cliPath: string;
    try {
      cliPath = require.resolve('@anthropic-ai/claude-code/cli.js');
    } catch {
      cliPath = join(process.cwd(), 'node_modules/@anthropic-ai/claude-code/cli.js');
    }

    this.logger.debug('Spawning Claude CLI', {
      cliPath,
      model: config.claude.model,
      workingDirectory,
      hasSlackContext: !!slackContext,
      mcpServerCount: Object.keys(allMcpServers).length,
    });

    const child = spawn('node', [cliPath, ...args], {
      cwd: workingDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: ctrl.signal,
      env: { ...process.env },
    });

    child.stdin.end();

    if (process.env.DEBUG) {
      child.stderr.on('data', (data: Buffer) => {
        this.logger.debug('Claude CLI stderr', data.toString());
      });
    }

    const cleanup = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    ctrl.signal.addEventListener('abort', cleanup);

    try {
      let processError: Error | null = null;
      child.on('error', (err: Error) => {
        processError = new Error(`Failed to spawn Claude CLI: ${err.message}`);
      });

      const processExitPromise = new Promise<void>((res, rej) => {
        child.on('close', (code: number | null) => {
          if (ctrl.signal.aborted) {
            rej(Object.assign(new Error('Claude CLI aborted'), { name: 'AbortError' }));
            return;
          }
          if (code !== 0) {
            rej(new Error(`Claude CLI exited with code ${code}`));
          } else {
            res();
          }
        });
      });

      const rl = createInterface({ input: child.stdout });

      for await (const line of rl) {
        if (processError) throw processError;
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as SDKMessage;
          if (message.type === 'system' && (message as any).subtype === 'init') {
            if (session) {
              session.sessionId = (message as any).session_id;
              this.logger.info('Session initialized', {
                sessionId: (message as any).session_id,
                model: (message as any).model,
                tools: (message as any).tools?.length || 0,
              });
            }
          }
          yield message;
        } catch {
          // Non-JSON line (e.g. debug output), skip
        }
      }

      await processExitPromise;
    } catch (error) {
      this.logger.error('Error in Claude CLI', error);
      throw error;
    } finally {
      ctrl.signal.removeEventListener('abort', cleanup);
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}
