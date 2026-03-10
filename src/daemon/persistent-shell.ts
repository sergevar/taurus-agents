import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface PersistentShellOpts {
  mode: 'host' | 'docker';
  container_id?: string;
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
  watchdog?: ReturnType<typeof setInterval>;
  onData?: (line: string) => void;
}

const DEFAULT_OUTPUT_LIMIT = 100_000; // 100KB
const DEFAULT_TIMEOUT = 120_000; // 2 min
const WATCHDOG_INTERVAL = 10_000; // 10s — how often to check if the command is still alive

export class PersistentShell {
  private proc: ChildProcess | null = null;
  private alive = false;
  private pending = new Map<string, PendingCommand>();
  private buffer = '';
  private shellPid?: number; // PID of the bash process inside the container
  private lastDataAt = 0; // timestamp of the most recent data received
  private readonly mode: PersistentShellOpts['mode'];
  private readonly container_id?: string;
  private readonly cwd?: string;
  private readonly env?: Record<string, string>;
  private readonly outputLimit: number;
  private readonly defaultTimeout: number;

  constructor(opts: PersistentShellOpts) {
    this.mode = opts.mode;
    this.container_id = opts.container_id;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.outputLimit = opts.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    this.defaultTimeout = opts.defaultTimeout ?? DEFAULT_TIMEOUT;

    if (this.mode === 'docker' && !this.container_id) {
      throw new Error('container_id required for docker mode');
    }
  }

  async spawn(): Promise<void> {
    if (this.alive) return;

    const args = this.mode === 'docker'
      ? ['exec', '-i', this.container_id!, 'bash', '--norc', '--noprofile']
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

    // Disable prompt and history to avoid noise, and emit shell PID for kill-on-timeout
    this.proc.stdin!.write('set +o history; PS1=""; PS2=""\n');
    this.proc.stdin!.write('echo "TAURUS_SHELLPID_$$"\n');

    // If host mode and cwd specified, cd into it
    if (this.mode === 'host' && this.cwd) {
      this.proc.stdin!.write(`cd ${JSON.stringify(this.cwd)}\n`);
    }
  }

  async exec(command: string, opts?: { timeout?: number; onData?: (line: string) => void }): Promise<CommandResult> {
    if (!this.alive || !this.proc) {
      throw new Error('Shell is not alive. Call spawn() first.');
    }

    const sentinelId = randomUUID();
    const timeout = opts?.timeout ?? this.defaultTimeout;

    return new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(sentinelId);
        if (pending) {
          this.clearPending(sentinelId, pending);
          // Strip any sentinel that may have leaked into stdout
          const cleanStdout = pending.stdout.replace(/\n?TAURUS_SENTINEL_[0-9a-f-]+_EXIT_\d+$/m, '').replace(/\n+$/, '');

          // Kill the foreground process so the shell returns to its prompt
          // and subsequent exec() calls work normally.
          this.interruptForeground();

          resolve({
            stdout: cleanStdout + '\n[Process killed: timeout exceeded]',
            exitCode: 124, // standard timeout exit code
            durationMs: Date.now() - pending.startTime,
          });
        }
      }, timeout);

      // Watchdog: periodically check if the command's process has died inside the
      // container but the sentinel never arrived (e.g. OrbStack I/O proxy stall).
      // If the shell has no children and no data has arrived recently, the command
      // finished but the sentinel was lost in transit — kill the docker exec
      // connection and respawn.
      const watchdog = this.shellPid && this.mode === 'docker'
        ? setInterval(() => this.watchdogCheck(sentinelId), WATCHDOG_INTERVAL)
        : undefined;

      this.pending.set(sentinelId, {
        resolve,
        reject,
        stdout: '',
        startTime: Date.now(),
        timer,
        watchdog,
        onData: opts?.onData,
      });

      // Send command with sentinel. Each part on its own line so that:
      // - Heredoc terminators (EOF etc.) are recognized (they must be alone on a line)
      // - Background commands (cmd &) work — & inside braces backgrounds the child,
      //   the group itself completes immediately, sentinel fires right away
      // - stderr is merged via 2>&1 on the brace group
      const wrappedCmd = [
        `{ ${command}`,
        `} </dev/null 2>&1`,
        `__taurus_rc=$?`,
        `echo`,
        `echo "TAURUS_SENTINEL_${sentinelId}_EXIT_$__taurus_rc"`,
        ``,
      ].join('\n');
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

  /** Clear a pending command's timers and remove it from the map. */
  private clearPending(id: string, pending: PendingCommand): void {
    clearTimeout(pending.timer);
    if (pending.watchdog) clearInterval(pending.watchdog);
    this.pending.delete(id);
  }

  /**
   * Watchdog: check if the command's process has died inside the container but
   * the sentinel never arrived. This catches OrbStack/Docker I/O proxy stalls
   * where data is written by bash but never reaches the host.
   *
   * If the shell has no children and no data has arrived for 10+ seconds,
   * we kill the docker exec connection. handleClose fires, which rejects the
   * pending command with an error. The caller (run-worker) can then decide
   * what to do (the agent loop treats it as a tool error).
   */
  private watchdogCheck(sentinelId: string): void {
    const pending = this.pending.get(sentinelId);
    if (!pending) return;
    if (!this.container_id || !this.shellPid) return;

    // Don't trigger if we've received data recently — the command is still producing output
    if (Date.now() - this.lastDataAt < WATCHDOG_INTERVAL) return;

    // Check if the shell has any non-zombie children inside the container
    execFile('docker', [
      'exec', this.container_id, 'sh', '-c',
      `ps -o pid=,stat= --ppid ${this.shellPid} 2>/dev/null | grep -v Z | head -1`,
    ], { timeout: 5000 }, (_err, stdout) => {
      // If we got a result (non-empty), there's still a live child → command is running
      if (stdout && stdout.trim()) return;
      // Re-check pending (might have resolved while we were checking)
      if (!this.pending.has(sentinelId)) return;

      // The command finished inside the container but the sentinel never arrived.
      // Kill the docker exec connection — handleClose will reject the pending command.
      console.error(
        `[persistent-shell] Watchdog: sentinel lost for shell PID ${this.shellPid} ` +
        `(no children, no data for ${Math.round((Date.now() - this.lastDataAt) / 1000)}s). ` +
        `Killing docker exec to recover.`
      );
      if (this.proc) {
        this.proc.kill('SIGKILL');
      }
    });
  }

  /**
   * Kill the foreground process inside the shell so it returns to the prompt.
   *
   * For docker mode: spawns a separate `docker exec` to kill all direct children
   * of the persistent bash shell. The shell itself survives.
   *
   * For host mode: sends SIGKILL to direct children of the bash process.
   */
  private interruptForeground(): void {
    if (this.mode === 'docker' && this.container_id && this.shellPid) {
      // Kill all direct children of the persistent shell via a separate docker exec.
      // The shell's own sentinel commands (queued in stdin) will still execute after
      // the children die — the sentinel fires with no matching pending entry and is
      // silently ignored. The shell is then clean for the next exec().
      execFile('docker', [
        'exec', this.container_id, 'sh', '-c',
        `kill -9 $(ps -o pid= --ppid ${this.shellPid}) 2>/dev/null; true`,
      ], { timeout: 5000 });
    } else if (this.mode === 'host' && this.proc?.pid) {
      // Kill direct children of the bash process
      execFile('sh', ['-c', `pkill -9 -P ${this.proc.pid} 2>/dev/null; true`], { timeout: 5000 });
    }

    // Clear buffer to avoid processing stale partial lines from the killed process
    this.buffer = '';
  }

  private handleData(chunk: Buffer): void {
    this.lastDataAt = Date.now();
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
    const cleaned = line.replace(/\r/g, '');

    // Check for shell PID marker (emitted during spawn)
    const pidMatch = cleaned.match(/^TAURUS_SHELLPID_(\d+)$/);
    if (pidMatch) {
      this.shellPid = parseInt(pidMatch[1], 10);
      return;
    }

    // Check for sentinel
    const match = cleaned.match(/^TAURUS_SENTINEL_([0-9a-f-]+)_EXIT_(\d+)$/);
    if (match) {
      const [, sentinelId, exitCodeStr] = match;
      const pending = this.pending.get(sentinelId);
      if (pending) {
        this.clearPending(sentinelId, pending);
        pending.resolve({
          stdout: pending.stdout.replace(/\n+$/, ''),
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

      // Stream output to caller if callback is set
      pending.onData?.(line);

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
      this.clearPending(id, pending);
      pending.reject(new Error('Shell process exited unexpectedly'));
    }
  }

  private handleError(err: Error): void {
    this.alive = false;
    for (const [id, pending] of this.pending) {
      this.clearPending(id, pending);
      pending.reject(err);
    }
  }
}
