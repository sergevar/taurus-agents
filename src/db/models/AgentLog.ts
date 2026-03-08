import { DataTypes, Model } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { Database } from '../index.js';
import type { LogLevel } from '../../daemon/types.js';

const sequelize = Database.init();

class AgentLog extends Model {
  declare id: string;
  declare agent_id: string;
  declare run_id: string | null;
  declare level: LogLevel;
  declare event: string;
  declare message: string;
  declare data: unknown;
  declare created_at: Date;

  toApi() {
    const { id, agent_id, run_id, level, event, message, data, created_at } = this;
    return { id, agent_id, run_id, level, event, message, data, created_at };
  }
}

AgentLog.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: uuidv4,
      primaryKey: true,
    },
    agent_id: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    run_id: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    level: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'info',
    },
    event: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    data: {
      type: DataTypes.JSON,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'AgentLogs',
    timestamps: true,
    underscored: true,
    updatedAt: false,
  }
);

export default AgentLog;
