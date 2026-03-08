/**
 * Taurus Daemon — the main entry point.
 *
 * Boots DB, creates Daemon, starts HTTP server, handles shutdown.
 * ./taurus runs this. Web UI on :7777.
 */

import 'dotenv/config';
import { Database } from './db/index.js';

// Import models so Sequelize registers them
import './db/models/Run.js';
import './db/models/Message.js';
import './db/models/Folder.js';
import './db/models/Agent.js';
import './db/models/AgentLog.js';

import { Daemon } from './daemon/daemon.js';
import { createServer } from './server/server.js';

const PORT = parseInt(process.env.TAURUS_PORT ?? '7777', 10);

async function main() {
  await Database.sync();

  const daemon = new Daemon();
  await daemon.init();

  const server = createServer(daemon, PORT);

  const agentCount = (await daemon.listAgents()).length;
  server.listen(PORT, () => {
    console.log(`\n  Taurus Daemon v0.1.0`);
    console.log(`  HTTP API: http://localhost:${PORT}`);
    console.log(`  Agents: ${agentCount}`);
    console.log(`  Ctrl+C to stop\n`);
  });

  // Graceful shutdown — debounce to avoid double-fire from terminal signal propagation
  let shutdownCount = 0;
  let shutdownInProgress = false;
  let lastSignalTime = 0;

  async function handleShutdown() {
    const now = Date.now();
    if (now - lastSignalTime < 500) return; // debounce
    lastSignalTime = now;
    shutdownCount++;

    if (shutdownCount === 1 && !shutdownInProgress) {
      shutdownInProgress = true;
      console.log('\nGraceful shutdown... (press Ctrl+C again to force)');
      try {
        await daemon.shutdown();
        server.close();
        await Database.close();
        process.exit(0);
      } catch (err) {
        console.error('Shutdown error:', err);
        process.exit(1);
      }
    } else if (shutdownCount >= 2) {
      console.log('\nForce shutdown — killing all children...');
      daemon.forceShutdown();
      setTimeout(() => process.exit(1), 2000);
    }
  }

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
