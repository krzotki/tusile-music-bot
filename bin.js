#!/usr/bin/env node
/**
 * The entry point, which is only an entry point.
 *
 * Separate from index.js so that importing the bot's behaviour in a test does not start it:
 * `require.main === module` had that job and does not exist in a module.
 */
import { main } from './index.js';

if (!process.env.CORE_SERVER_URL || !process.env.BOT_KEY || !process.env.BOT_SECRET) {
  console.error('Set CORE_SERVER_URL, BOT_KEY and BOT_SECRET. See README.md.');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
