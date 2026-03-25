import { syncSlackStatus } from './slackSync.js';

syncSlackStatus().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
