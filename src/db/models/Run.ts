import { DataTypes, Model } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../index.js';
import { DEFAULT_MODEL } from '../../core/defaults.js';

const sequelize = Database.init();

export type RunStatus = 'running' | 'paused' | 'completed' | 'error' | 'stopped';

class Run extends Model {
  declare id: string;
  declare name: string | null;
  declare status: RunStatus;
  declare cwd: string;
  declare model: string;
  declare total_input_tokens: number;
  declare total_output_tokens: number;
  declare total_cost_usd: number;
  declare agent_id: string | null;
  declare trigger: string | null;
  declare run_summary: string | null;
  declare run_error: string | null;
  declare created_at: Date;
  declare updated_at: Date;

  // ─── Instance methods ───

  async getMessages() {
    const { default: Message } = await import('./Message.js');
    return Message.findAll({
      where: { run_id: this.id },
      order: [['created_at', 'ASC']],
    });
  }

  async addMessage(role: string, content: any, opts?: { stopReason?: string; inputTokens?: number; outputTokens?: number }) {
    const { default: Message } = await import('./Message.js');
    const maxSeq = await Message.max('seq', { where: { run_id: this.id } }) as number || 0;
    return Message.create({
      run_id: this.id,
      seq: maxSeq + 1,
      role,
      content,
      stop_reason: opts?.stopReason ?? null,
      input_tokens: opts?.inputTokens ?? 0,
      output_tokens: opts?.outputTokens ?? 0,
    });
  }

  toApi() {
    const { id, name, status, cwd, model, total_input_tokens, total_output_tokens, total_cost_usd, agent_id, trigger, run_summary, run_error, created_at, updated_at } = this;
    return { id, name, status, cwd, model, total_input_tokens, total_output_tokens, total_cost_usd, agent_id, trigger, run_summary, run_error, created_at, updated_at };
  }
}

Run.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: uuidv4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'running',
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
    total_input_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    total_output_tokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    total_cost_usd: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    agent_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    trigger: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    run_summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    run_error: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'Runs',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  }
);

export default Run;
