const config = require('./config');
const db = require('./db');
const autofix = require('./autofix');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

db.open();
const app = require('./app');
autofix.startSyncLoop();

app.listen(config.PORT, () => {
  console.log(`Lantern Desk on http://localhost:${config.PORT}`);
  console.log(autofix.enabled() ? `AutoFix bridge: ${config.AUTOFIX_URL}` : 'AutoFix bridge: off (set AUTOFIX_URL)');
});
