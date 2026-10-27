const config = require('./config');
const db = require('./db');
const autofix = require('./autofix');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

(async () => {
  try {
    await db.open();
  } catch (err) {
    console.error(`Could not connect to MongoDB: ${err.message}`);
    console.error('Check MONGODB_URI, the password, and that Atlas Network Access allows this IP.');
    process.exit(1);
  }
  const app = require('./app');
  autofix.startSyncLoop();
  app.listen(config.PORT, () => {
    console.log(`Lantern Desk on http://localhost:${config.PORT} (MongoDB database "${config.MONGODB_DB}")`);
    console.log(autofix.enabled() ? `AutoFix bridge: ${config.AUTOFIX_URL}` : 'AutoFix bridge: off (set AUTOFIX_URL)');
  });
})();
