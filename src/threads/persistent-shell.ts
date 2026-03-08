import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface PersistentShellOpts {
  mode: 'host' | 'docker';
  containerId?: string;
  cwd?: string;
  env?: Record<string, string>;
  outputLimit?: number;
  defaultTimeout?: number;
}

export interface CommandResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
}

interface PendingCommand {
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  stdout: string;
  startTime: number;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_OUTPUT_LIMIT = 100_000; // 100KB
const DEFAULT_TIMEOUT = 120_000; // 2 min

export class PersistentShell {
  private proc: ChildProcess | null = null;
  private alive = false;
  private pending = new Map<string, PendingCommand>();
  private buffer = '';
  private readonly mode: PersistentShellOpts['mode'];
  private readonly containerId?: string;
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly outputLimit: number;
  private readonly defaultTimeout: number;

  constructor(opts: PersistentShellOpts) {
    this.mode = opts.mode;
    this.containerId = opts.containerId;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.outputLimit = opts.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    this.defaultTimeout = opts.defaultTimeout ?? DEFAULT_TIMEOUT;

    if (this.mode === 'docker' && !this.containerId) {
      throw new Error('containerId required for docker mode');
    }
  }

  async spawn(): Promise<void> {
    if (this.alive) return;

    const args = this.mode === 'docker'
      ? ['exec', '-i', this.containerId!, 'bash', '--norc', '--noprofile']
      : ['--norc', '--noprofile'];

    const cmd = this.mode === 'docker' ? 'docker' : 'bash';

    this.proc = spawn(cmd, args, {
      cwd: this.mode === 'host' ? this.cwd : undefined,
      env: this.mode === 'host' ? { ...process.env, ...this.env } : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => this.handleData(chunk));
    // Merge stderr into the same handling — we redirect in exec() anyway
    this.proc.stderr!.on('data', (chunk: Buffer) => this.handleData(chunk));

    this.proc.on('close', (code) => this.handleClose(code));
    this.proc.on('error', (err) => this.handleError(err));

    this.alive = true;

    // Disable prompt and history to avoid noise
    this.proc.stdin!.write('set +o history; PS1=""; PS2=""\n');

    // If host mode and cwd specified, cd into it
    if (this.mode === 'host' && this.cwd) {
      this.proc.stdin!.write(`cd ${JSON.stringify(this.cwd)}\n`);
    }
  }

  async exec(command: string, opts?: { timeout?: number }): Promise<CommandResult> {
    if (!this.alive || !this.proc) {
      throw new Error('Shell is not alive. Call spawn() first.');
    }

    const sentinelId = randomUUID();
    const timeout = opts?.timeout ?? this.defaultTimeout;

    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(sentinelId);
        if (pending) {
          this.pending.delete(sentinelId);
          resolve({
            stdout: pending.stdout + '\n[Process killed: timeout exceeded]',
            exitCode: 124, // standard timeout exit code
            durationMs: Date.now() - pending.startTime,
          });
        }
      }, timeout);

      this.pending.set(sentinelId, {
        resolve,
        reject,
        stdout: '',
        startTime: Date.now(),
        timer,
      });

      // Send command with sentinel. Merge stderr via 2>&1.
      const wrappedCmd = `{ ${command}; } 2>&1; echo "TAURUS_SENTINEL_${sentinelId}_EXIT_$?"\n`;
      this.proc!.stdin!.write(wrappedCmd);
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  async close(): Promise<void> {
    if (!this.alive || !this.proc) return;

    this.proc.stdin!.write('exit\n');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.proc && this.alive) {
          this.proc.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.proc!.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.alive = false;
  }

  // ── Internal ──

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    // Check for sentinel
    const match = line.match(/^TAURUS_SENTINEL_([0-9a-f-]+)_EXIT_(\d+)$/);
    if (match) {
      const [, sentinelId, exitCodeStr] = match;
      const pending = this.pending.get(sentinelId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(sentinelId);
        pending.resolve({
          stdout: pending.stdout,
          exitCode: parseInt(exitCodeStr, 10),
          durationMs: Date.now() - pending.startTime,
        });
      }
      return;
    }

    // Append to the most recent pending command's stdout
    // (commands run sequentially, so there's at most one active)
    if (this.pending.size > 0) {
      const [, pending] = [...this.pending.entries()][0];
      if (pending.stdout.length > 0) {
        pending.stdout += '\n';
      }
      pending.stdout += line;

      // Enforce output limit
      if (pending.stdout.length > this.outputLimit) {
        pending.stdout = pending.stdout.slice(0, this.outputLimit) + '\n[output truncated]';
      }
    }
  }

  private handleClose(_code: number | null): void {
    this.alive = false;
    // Reject all pending commands
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Shell process exited unexpectedly'));
      this.pending.delete(id);
    }
  }

  private handleError(err: Error): void {
    this.alive = false;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
