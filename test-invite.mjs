import { createDecipheriv } from 'node:crypto';
import pg from 'pg';

const db = new pg.Client(process.env.DATABASE_URL);
await db.connect();

const { rows } = await db.query('SELECT api_key_encrypted FROM agent_org_mappings WHERE is_active = true LIMIT 1');
const key = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
const buf = Buffer.from(rows[0].api_key_encrypted, 'base64');
const nonce = buf.subarray(0, 12);
const tag = buf.subarray(buf.length - 16);
const ct = buf.subarray(12, buf.length - 16);
const decipher = createDecipheriv('aes-256-gcm', key, nonce);
decipher.setAuthTag(tag);
const apiKey = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');

const { rows: teams } = await db.query('SELECT external_team_id FROM agent_team_mappings LIMIT 1');
const teamId = teams[0].external_team_id;

const reqBody = { emailId: 'test-proof@deecodes.io', userName: 'Test Proof', roleId: '897ed114-a530-4246-ae19-417e835d0508', teams: [teamId], workMode: 'office' };
console.log('REQUEST:', JSON.stringify(reqBody, null, 2));

const res = await fetch('https://api.trackpilots.com/v1/employees/send-invite-link', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody)
});

const body = await res.json();
console.log('STATUS:', res.status);
console.log('RESPONSE:', JSON.stringify(body, null, 2));
await db.end();
