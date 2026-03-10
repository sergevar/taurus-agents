/**
 * DockerService — manages container lifecycle.
 *
 * Handles create/start/stop/remove of Docker containers and volumes.
 * All calls are async (uses execFile instead of execSync).
 */

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Agent from '../db/models/Agent.js';
import type { LogLevel } from './types.js';

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class DockerService {
  private logger: (level: LogLevel, msg: string) => void;

  constructor(logger: (level: LogLevel, msg: string) => void) {
    this.logger = logger;
  }

  private async docker(...args: string[]): Promise<string> {
    const { stdout } = await exec('docker', args, { timeout: 30_000 });
    return stdout.trim();
  }

  async isContainerRunning(container_id: string): Promise<boolean> {
    try {
      // Use State.Status instead of State.Running — a paused container has
      // Running=true but Status='paused', and we can't docker exec into it.
      const status = await this.docker('inspect', '--format', '{{.State.Status}}', container_id);
      return status === 'running';
    } catch {
      return false;
    }
  }

  async containerExists(container_id: string): Promise<boolean> {
    try {
      await this.docker('inspect', container_id);
      return true;
    } catch {
      return false;
    }
  }

  async ensureContainer(agent: Agent): Promise<void> {
    const { container_id, docker_image } = agent;

    if (await this.isContainerRunning(container_id)) return;

    if (await this.containerExists(container_id)) {
      // May be paused or stopped — unpause first, then start if needed
      await this.unpauseContainer(container_id);
      if (!(await this.isContainerRunning(container_id))) {
        await this.docker('start', container_id);
        this.logger('info', `Container started: ${container_id}`);
      }
      return;
    }

    // Create volume
    const volumeName = `taurus-vol-${agent.id}`;
    try {
      await this.docker('volume', 'create', volumeName);
    } catch {
      // Volume may already exist
    }

    // Create and start container
    // Chromium/Playwright needs >64MB /dev/shm; --shm-size is safer than --ipc=host
    const createArgs = [
      'create', '--name', container_id,
      '--shm-size=256m',
      '-v', `${volumeName}:/workspace`,
    ];

    // Add bind mounts (validate paths are absolute)
    const mounts = typeof agent.mounts === 'string' ? JSON.parse(agent.mounts) : (agent.mounts ?? []);
    for (const m of mounts) {
      if (!m.host.startsWith('/')) throw new Error(`Bind mount host path must be absolute: ${m.host}`);
      if (!m.container.startsWith('/')) throw new Error(`Bind mount container path must be absolute: ${m.container}`);
      const spec = m.readonly ? `${m.host}:${m.container}:ro` : `${m.host}:${m.container}`;
      createArgs.push('-v', spec);
    }

    createArgs.push('-w', '/workspace', docker_image, 'sleep', 'infinity');
    await this.docker(...createArgs);
    await this.docker('start', container_id);

    // Copy scaffold into /workspace
    const scaffoldDir = path.join(__dirname, '..', '..', 'scaffold');
    try {
      await this.docker('cp', `${scaffoldDir}/.`, `${container_id}:/workspace/`);
      this.logger('info', `Scaffold copied into ${container_id}:/workspace/`);
    } catch {
      this.logger('warn', `No scaffold directory found or copy failed — container starts empty`);
    }

    this.logger('info', `Container created and started: ${container_id} (image: ${docker_image})`);
  }

  async pauseContainer(container_id: string): Promise<void> {
    try {
      const status = await this.docker('inspect', '--format', '{{.State.Status}}', container_id);
      if (status === 'running') {
        await this.docker('pause', container_id);
        this.logger('info', `Container paused: ${container_id}`);
      }
    } catch (err: any) {
      this.logger('warn', `Failed to pause container ${container_id}: ${err.message}`);
    }
  }

  async unpauseContainer(container_id: string): Promise<void> {
    try {
      const status = await this.docker('inspect', '--format', '{{.State.Status}}', container_id);
      if (status === 'paused') {
        await this.docker('unpause', container_id);
        this.logger('info', `Container unpaused: ${container_id}`);
      }
    } catch (err: any) {
      this.logger('warn', `Failed to unpause container ${container_id}: ${err.message}`);
    }
  }

  async stopContainer(container_id: string): Promise<void> {
    if (await this.isContainerRunning(container_id)) {
      try {
        await this.docker('stop', '-t', '5', container_id);
        this.logger('info', `Container stopped: ${container_id}`);
      } catch (err: any) {
        this.logger('warn', `Failed to stop container ${container_id}: ${err.message}`);
      }
    }
  }

  /** Remove container only (keep volume). Will be recreated on next ensureContainer. */
  async destroyContainer(container_id: string): Promise<void> {
    try { await this.docker('rm', '-f', container_id); } catch { /* ignore */ }
    this.logger('info', `Container destroyed (volume preserved): ${container_id}`);
  }

  async removeContainer(container_id: string): Promise<void> {
    try { await this.docker('rm', '-f', container_id); } catch { /* ignore */ }
    try { await this.docker('volume', 'rm', `taurus-vol-${container_id.replace('taurus-agent-', '')}`); } catch { /* ignore */ }
    this.logger('info', `Container removed: ${container_id}`);
  }

  /** Run an ad-hoc command in a container and return stdout. */
  async execCommand(container_id: string, command: string[]): Promise<string> {
    return this.docker('exec', container_id, ...command);
  }

  /** Run a command in a container with stdin piped. */
  async execWithStdin(container_id: string, command: string[], stdin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = nodeSpawn('docker', ['exec', '-i', container_id, ...command]);
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d; });
      proc.stderr.on('data', (d: Buffer) => { stderr += d; });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || `Exit code ${code}`));
      });
      proc.on('error', reject);
      proc.stdin.write(stdin);
      proc.stdin.end();
    });
  }
}
