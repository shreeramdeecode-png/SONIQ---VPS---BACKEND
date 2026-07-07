const { Client } = require('pg');
const c = new Client('postgresql://soniq_user:Pass12345@localhost:5432/soniq_db');
c.connect().then(async () => {
  const now = await c.query("SELECT now() at time zone 'UTC' as utc_now");
  console.log('UTC now:', now.rows[0].utc_now);

  const ds = await c.query(
    "SELECT summary_date::date d, count(*) emps, sum(total_work_seconds) work, " +
    "round(avg(productivity_score)::numeric,1) avg_score " +
    "FROM daily_summaries GROUP BY summary_date::date ORDER BY d DESC LIMIT 5");
  console.log('\nDaily summaries by date:');
  ds.rows.forEach(r => console.log('  ' + r.d.toISOString().slice(0,10) + '  emps=' + r.emps + ' work=' + r.work + ' avgScore=' + r.avg_score));

  const ae = await c.query("SELECT max(received_at) latest, count(*) FROM activity_events WHERE received_at::date = (now() at time zone 'UTC')::date");
  console.log('\nActivity events TODAY (UTC):', ae.rows[0].count, ' latest=', ae.rows[0].latest);

  const emp = await c.query("SELECT name, is_currently_working, last_seen_at FROM