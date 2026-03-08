import { DataTypes, Model } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../index.js';
import { ROOT_FOLDER_ID } from '../../daemon/types.js';
import type { AgentType, AgentStatus } from '../../daemon/types.js';
import { DEFAULT_MODEL, DEFAULT_DOCKER_IMAGE } from '../../core/defaults.js';

const sequelize = Database.init();

class Agent extends Model {
  declare id: string;
  declare folder_id: string;
  declare name: string;
  declare type: AgentType;
  declare status: AgentStatus;
  declare cwd: string;
  declare model: string;
  declare system_prompt: string;
  declare tools: string[];
  declare schedule: string | null;
  declare schedule_overlap: 'skip' | 'queue' | 'kill';
  declare max_turns: number;
  declare timeout_ms: number;
  declare metadata: Record<string, unknown> | null;
  declare docker_image: string;
  declare created_at: Date;
  declare updated_at: Date;

  get container_id(): string {
    return `taurus-agent-${this.id}`;
  }

  toApi() {
    const { id, folder_id, name, type, status, cwd, model, system_prompt, tools, schedule, schedule_overlap, max_turns, timeout_ms, metadata, docker_image, created_at, updated_at } = this;
    return { id, folder_id, name, type, status, cwd, model, system_prompt, tools, schedule, schedule_overlap, max_turns, timeout_ms, metadata, docker_image, created_at, updated_at };
  }
}

Agent.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: uuidv4,
      primaryKey: true,
    },
    folder_id: {
      type: DataTypes.UUID,
      allowNull: false,
      defaultValue: ROOT_FOLDER_ID,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'idle',
    },
    cwd: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    model: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: DEFAULT_MODEL,
    },
    system_prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    tools: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    schedule: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    schedule_overlap: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'skip',
    },
    max_turns: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 20,
    },
    timeout_ms: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 300_000,
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    docker_image: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: DEFAULT_DOCKER_IMAGE,
    },
  },
  {
    sequelize,
    tableName: 'Agents',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

export default Agent;
