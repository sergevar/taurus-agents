import { Sequelize } from 'sequelize';
import path from 'node:path';
import fs from 'node:fs';

export class Database {
  static client: Sequelize;

  static init(dbPath?: string) {
    if (!Database.client) {
      const storage = dbPath ?? path.join(process.cwd(), 'data', 'taurus.sqlite');

      const dir = path.dirname(storage);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      Database.client = new Sequelize({
        dialect: 'sqlite',
        storage,
        logging: false,
      });
    }

    return Database.client;
  }

  static async sync() {
    const sequelize = Database.init();
    await sequelize.query('PRAGMA journal_mode=WAL');
    await sequelize.sync({ alter: true });
  }

  static async close() {
    if (Database.client) {
      await Database.client.close();
    }
  }
}

// Auto-init on import
Database.init();

export const sequelize = Database.client;
