import { PrismaClient } from '@prisma/client';
import { TrackpilotsService } from './dist/infrastructure/agents/trackpilots.service.js';
import { AgentSyncService } from './dist/superAdmin/agentSync.service.js';
import { EncryptionService } from './dist/infrastructure/encryption.service.js';
import { AuditService } from './dist/infrastructure/audit.service.js';
import { readFileSync } from 'fs';

const envFile = readFileSync('/var/www/soniq-node/.env', 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
}

const db = new PrismaClient();
const encryption = new EncryptionService(process.env.ENCRYPTION_KEY);
const audit = new AuditService(db);
const trackpilots = new TrackpilotsService(
  process.env.TRACKPILOTS_BASE_URL || 'https://api.trackpilots.com',
  db, encryption
);
const agentSync = new AgentSyncService(db, trackpilots, audit);

const orgId = '52ac45ff-7a7a-4cfe-87d9-2c2b315fb702';
console.log('Syncing org:', orgId);

try {
  const report = await agentSync.syncOrg('system', orgId);
  console.log('Done:', JSON.stringify(report, null, 2));
} catch (err) {
  console.error('Failed:', err.message);
} finally {
  await db.$disconnect();
}
