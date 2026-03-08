/**
 * DockerService — manages container lifecycle.
 *
 * Handles create/start/stop/remove of Docker containers and volumes.
 * All calls are async (uses execFile instead of execSync).
 */

import { execFile } from 'node:child_process';
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
      const state = await this.docker('inspect', '--format', '{{.State.Running}}', container_id);
      return state === 'true';
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
      await this.docker('start', container_id);
      this.logger('info', `Container started: ${container_id}`);
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
    await this.docker(
      'create', '--name', container_id,
      '-v', `${volumeName}:/workspace`,
      '-w', '/workspace',
      docker_image, 'sleep', 'infinity',
    );
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

  async removeContainer(container_id: string): Promise<void> {
    try { await this.docker('rm', '-f', container_id); } catch { /* ignore */ }
    try { await this.docker('volume', 'rm', `taurus-vol-${container_id.replace('taurus-agent-', '')}`); } catch { /* ignore */ }
    this.logger('info', `Container removed: ${container_id}`);
  }
}
