const { Client } = require('pg');
const c = new Client('postgresql://soniq_user:Pass12345@localhost:5432/soniq_db');
c.connect().then(async () => {
  // distinct app names + how Trackpilots labels them
  const r = await c.query(
    "SELECT DISTINCT ON (app_name) app_name, app_domain, app_category, app_type, productivity_status, raw_payload " +
    "FROM activity_events WHERE app_name IS NOT NULL ORDER BY app_name, received_at DESC LIMIT 12"
  );
  for (const row of r.rows) {
    const p = row.raw_payload;
    const item = Array.isArray(p.data) ? p.data[0] : p.data;
    const rawApp = item && item.tracking ? item.tracking.app : null;
    console.log('=== ' + row.app_name + ' ===');
    console.log('  STORED:', JSON.stringify({ domain: row.app_domain, category: row.app_category, type: row.app_type, status: row.productivity_status }));
    console.log('  RAW   :', JSON.stringify(rawApp));
  }
  await c.end();
}).catch(e => { console.error(e.message); process.exit(1); });
