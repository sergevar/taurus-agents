/**
 * Scheduler — manages cron-based agent wake-ups.
 *
 * Reads `schedule` (cron expression) and `schedule_overlap` (skip|queue|kill)
 * from each agent. Uses croner to fire callbacks at the right times.
 *
 * Lifecycle: init() after Daemon.init(), shutdown() before Daemon.shutdown().
 */

import { Cron, type CronOptions } from 'croner';
import cronstrue from 'cronstrue';
import type { LogLevel } from './types.js';

/** Human-friendly shorthands → cron expressions */
const SHORTHAND_MAP: Record<string, string> = {
  'every minute':    '* * * * *',
  'every 5 minutes': '*/5 * * * *',
  'every 10 minutes':'*/10 * * * *',
  'every 15 minutes':'*/15 * * * *',
  'every 30 minutes':'*/30 * * * *',
  'every hour':      '0 * * * *',
  'every 2 hours':   '0 */2 * * *',
  'every 4 hours':   '0 */4 * * *',
  'every 6 hours':   '0 */6 * * *',
  'every 12 hours':  '0 */12 * * *',
  'daily':           '0 9 * * *',
  'daily at midnight':'0 0 * * *',
  'weekly':          '0 9 * * 1',
  'monthly':         '0 9 1 * *',
  'hourly':          '0 * * * *',
};

// Parse various schedule formats into a cron expression.
// Supports standard cron, shorthands ("every 5 minutes", "daily", "hourly"),
// compact form ("every 5m", "every 2h"), and "daily at HH:MM".
export function parseSchedule(input: string): string {
  const trimmed = input.trim().toLowerCase();

  // Check shorthand map first
  if (SHORTHAND_MAP[trimmed]) {
    return SHORTHAND_MAP[trimmed];
  }

  // "every Xm" / "every Xh" / "every Xd"
  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/);
  if (everyMatch) {
    const val = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2][0]; // 'm', 'h', or 'd'
    if (unit === 'm') return `*/${val} * * * *`;
    if (unit === 'h') return `0 */${val} * * *`;
    if (unit === 'd') return `0 9 */${val} * *`;
  }

  // "daily at HH:MM" or "daily at H:MM am/pm"
  const dailyMatch = trimmed.match(/^daily\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const min = parseInt(dailyMatch[2], 10);
    const ampm = dailyMatch[3];
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return `${min} ${hour} * * *`;
  }

  // Assume it's already a cron expression — validate by trying to construct
  return trimmed;
}

/**
 * Validate a schedule string. Returns the parsed cron expression or throws.
 */
export function validateSchedule(input: string): string {
  const cron = parseSchedule(input);
  // Validate by constructing a Cron (will throw on invalid)
  const job = new Cron(cron, { paused: true }, () => {});
  job.stop();
  return cron;
}

/**
 * Get a human-readable description of a cron expression.
 */
export function describeSchedule(cronExpr: string): string {
  try {
    return cronstrue.toString(cronExpr);
  } catch {
    return cronExpr;
  }
}

/**
 * Get the next N run times for a cron expression.
 */
export function getNextRuns(cronExpr: string, count: number = 1): Date[] {
  try {
    const job = new Cron(cronExpr, { paused: true }, () => {});
    const runs = job.nextRuns(count);
    job.stop();
    return runs;
  } catch {
    return [];
  }
}

export type OverlapPolicy = 'skip' | 'queue' | 'kill';

interface ScheduledAgent {
  agentId: string;
  job: Cron;
  queue: (() => void)[];  // for 'queue' overlap policy
}

interface DaemonInterface {
  startRun(agentId: string, trigger: 'schedule'): Promise<string>;
  stopRun(agentId: string, reason: string): Promise<void>;
  isRunning(agentId: string): boolean;
}

export class Scheduler {
  private jobs = new Map<string, ScheduledAgent>();
  private logger: (level: LogLevel, msg: string) => void;
  private daemon: DaemonInterface;

  constructor(daemon: DaemonInterface, logger: (level: LogLevel, msg: string) => void) {
    this.daemon = daemon;
    this.logger = logger;
  }

  /**
   * Register or update a scheduled agent. Pass schedule=null to unregister.
   */
  register(agentId: string, schedule: string | null, overlap: OverlapPolicy = 'skip'): void {
    // Always remove existing job first
    this.unregister(agentId);

    if (!schedule) return;

    let cronExpr: string;
    try {
      cronExpr = validateSchedule(schedule);
    } catch (err: any) {
      this.logger('warn', `[Scheduler] Invalid schedule for agent ${agentId}: ${err.message}`);
      return;
    }

    const job = new Cron(cronExpr, { timezone: undefined } as CronOptions, async () => {
      await this.fire(agentId, overlap);
    });

    this.jobs.set(agentId, { agentId, job, queue: [] });

    const next = job.nextRun();
    this.logger('info',
      `[Scheduler] Registered agent ${agentId}: "${describeSchedule(cronExpr)}" — next run: ${next?.toISOString() ?? 'never'}`
    );
  }

  /**
   * Remove a scheduled agent.
   */
  unregister(agentId: string): void {
    const existing = this.jobs.get(agentId);
    if (existing) {
      existing.job.stop();
      this.jobs.delete(agentId);
    }
  }

  /**
   * Get the next run time for a given agent.
   */
  getNextRun(agentId: string): Date | null {
    const entry = this.jobs.get(agentId);
    if (!entry) return null;
    return entry.job.nextRun() ?? null;
  }

  /**
   * Fire a scheduled run for an agent, respecting overlap policy.
   */
  private async fire(agentId: string, overlap: OverlapPolicy): Promise<void> {
    const isRunning = this.daemon.isRunning(agentId);

    if (isRunning) {
      switch (overlap) {
        case 'skip':
          this.logger('info', `[Scheduler] Skipping scheduled run for agent ${agentId} — already running`);
          return;

        case 'queue':
          this.logger('info', `[Scheduler] Queuing scheduled run for agent ${agentId} — already running`);
          // We'll check the queue when a run completes
          const entry = this.jobs.get(agentId);
          if (entry) {
            entry.queue.push(() => {
              this.startScheduledRun(agentId);
            });
          }
          return;

        case 'kill':
          this.logger('info', `[Scheduler] Killing current run for agent ${agentId} to start scheduled run`);
          try {
            await this.daemon.stopRun(agentId, 'schedule overlap: kill policy');
          } catch (err: any) {
            this.logger('error', `[Scheduler] Failed to stop agent ${agentId}: ${err.message}`);
          }
          // Small delay to let the process exit
          await new Promise(r => setTimeout(r, 1000));
          break;
      }
    }

    await this.startScheduledRun(agentId);
  }

  private async startScheduledRun(agentId: string): Promise<void> {
    try {
      const runId = await this.daemon.startRun(agentId, 'schedule');
      this.logger('info', `[Scheduler] Started scheduled run ${runId} for agent ${agentId}`);
    } catch (err: any) {
      this.logger('error', `[Scheduler] Failed to start scheduled run for agent ${agentId}: ${err.message}`);
    }
  }

  /**
   * Call this when a run completes to process queued runs.
   */
  onRunComplete(agentId: string): void {
    const entry = this.jobs.get(agentId);
    if (!entry || entry.queue.length === 0) return;

    const next = entry.queue.shift()!;
    this.logger('info', `[Scheduler] Processing queued run for agent ${agentId} (${entry.queue.length} remaining)`);
    next();
  }

  /**
   * Stop all scheduled jobs.
   */
  shutdown(): void {
    for (const [id, entry] of this.jobs) {
      entry.job.stop();
    }
    this.jobs.clear();
    this.logger('info', '[Scheduler] All scheduled jobs stopped.');
  }
}
