import { DataTypes, Model } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../index.js';
import { ROOT_FOLDER_ID } from '../../threads/types.js';
import type { ThreadConfig, ThreadType, ThreadStatus } from '../../threads/types.js';

const sequelize = Database.init();

class Thread extends Model {
  declare id: string;
  declare folder_id: string;
  declare name: string;
  declare type: ThreadType;
  declare status: ThreadStatus;
  declare cwd: string;
  declare model: string;
  declare system_prompt: string;
  declare tools: string;       // JSON array
  declare schedule: string | null;
  declare max_turns: number;
  declare timeout_ms: number;
  declare metadata: string | null; // JSON blob
  declare docker_image: string;
  declare created_at: Date;
  declare updated_at: Date;

  toConfig(): ThreadConfig {
    const containerId = `taurus-thread-${this.id}`;
    return {
      id: this.id,
      folderId: this.folder_id,
      name: this.name,
      type: this.type,
      status: this.status,
      cwd: this.cwd,
      model: this.model,
      systemPrompt: this.system_prompt,
      tools: JSON.parse(this.tools),
      schedule: this.schedule,
      maxTurns: this.max_turns,
      timeoutMs: this.timeout_ms,
      metadata: this.metadata ? JSON.parse(this.metadata) : {},
      containerId,
      dockerImage: this.docker_image,
    };
  }

  toApi() {
    return {
      ...this.toConfig(),
      createdAt: this.created_at,
      updatedAt: this.updated_at,
    };
  }
}

Thread.init(
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
      defaultValue: 'claude-sonnet-4-20250514',
    },
    system_prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    tools: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '[]',
    },
    schedule: {
      type: DataTypes.STRING,
      allowNull: true,
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
      type: DataTypes.TEXT,
      allowNull: true,
    },
    docker_image: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'ubuntu:22.04',
    },
  },
  {
    sequelize,
    tableName: 'Threads',
    timestamps: true,
    underscored: true,
  }
);

export default Thread;
