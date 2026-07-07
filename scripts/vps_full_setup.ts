import { PrismaClient } from '@prisma/client';
import { EncryptionService } from '../src/infrastructure/encryption.service.js';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import bcrypt from 'bcryptjs';
const DB_URL = process.env['DATABASE_URL'];
if (!DB_URL) { console.error('DATABASE_URL required'); process.exit(1); }
const ENCRYPTION_KEY = 'RGV2RW5jcnlwdGlvbktleTEyMzQ1Njc4OTAxMjM0NTY=';
const API_KEY = '5336c095f51d7ee0b1289bbcbba47548bccf453a8862833e006631c1cff1661ea62394fb3c0691635065ed7721ee18e1';
const EXTERNAL_ORG_ID = '93552797-2d06-4375-b368-f795bffc98bb';
const WEBHOOK_SECRET = '6fac7830fac2ba61bc8c1e6b7a9962e6b921e329b0f2c5aad778fd32dfb16886';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const encryption = new EncryptionService(ENCRYPTION_KEY);
const http = axios.create({ baseURL: 'https://api.trackpilots.com', headers: { Authorization: `Bearer ${API_KEY}` } });
async function run() {
  const org = await db.organization.findFirst({ select: { id: true, name: true } });
  if (!org) { console.error('No org found'); return; }
  console.log('Org:', org.name, org.id);
  const orgId = org.id;
  const roleMap: Record<string, string> = {};
  for (const name of ['Admin','Manager','Employee']) {
    let r = await db.role.findFirst({ where: { orgId, name } });
    if (!r) { r = await db.role.create({ data: { id: randomUUID(), orgId, name, permissions: [], updatedAt: new Date() } }); console.log('Created role:', name); }
    roleMap[name] = r.id;
  }
  const es = await db.orgDefaultSetting.findUnique({ where: { orgId } });
  if (!es) {
    await db.orgDefaultSetting.create({ data: { id: randomUUID(), orgId, defaultWorkDays: { mon:true,tue:true,wed:true,thu:true,fri:true,sat:false,sun:false }, defaultWorkHoursPerDay:8, defaultProductiveHoursPerDay:6, defaultScreenshotEnabled:true, defaultBlurEnabled:false, defaultCaptureIntervalMinutes:10, defaultIdleAlertEnabled:true, defaultMinIdleTimeMinutes:5, defaultStealthEnabled:false, timezone:'Asia/Kolkata', updatedAt: new Date() } });
    console.log('Created OrgDefaultSetting');
  }
  const orphans = await db.employee.findMany({ where: { orgId, deletedAt: null, agentEmployeeMappings: { none: {} } }, select: { id: true, name: true } });
  for (const e of orphans) { await db.clientAuth.deleteMany({ where: { employeeId: e.id } }); await db.employee.delete({ where: { id: e.id } }); console.log('Removed:', e.name); }
  const orphanTeams = await db.team.findMany({ where: { orgId, deletedAt: null, agentTeamMappings: { none: {} } }, select: { id: true, name: true } });
  for (const t of orphanTeams) { await db.team.delete({ where: { id: t.id } }); console.log('Removed team:', t.name); }
  let m = await db.agentOrgMapping.findFirst({ where: { orgId, isActive: true } });
  if (!m) { await db.agentOrgMapping.create({ data: { id: randomUUID(), orgId, agentProvider:'trackpilots', externalOrgId: EXTERNAL_ORG_ID, apiKeyEncrypted: encryption.encrypt(API_KEY), webhookSecretEncrypted: encryption.encrypt(WEBHOOK_SECRET), isActive: true, updatedAt: new Date() } }); console.log('Created AgentOrgMapping'); }
  const tpTeams = (await http.get('v1/teams')).data.data;
  console.log('Trackpilots teams:', tpTeams.length);
  const teamMap = new Map<string, string>();
  for (const t of tpTeams) {
    let team = await db.team.findFirst({ where: { orgId, name: t.teamName, deletedAt: null } });
    if (!team) { team = await db.team.create({ data: { id: randomUUID(), orgId, name: t.teamName, updatedAt: new Date() } }); console.log('Created team:', t.teamName); }
    teamMap.set(t.teamId, team.id);
    const em = await db.agentTeamMapping.findFirst({ where: { orgId, externalTeamId: t.teamId } });
    if (!em) await db.agentTeamMapping.create({ data: { id: randomUUID(), teamId: team.id, orgId, agentProvider:'trackpilots', externalTeamId: t.teamId } });
  }
  const tpEmps = (await http.get('v1/employees')).data.data;
  console.log('Trackpilots employees:', tpEmps.length);
  const pwHash = await bcrypt.hash('Employee@123', 10);
  for (const u of tpEmps) {
    const email = u.emailId.toLowerCase();
    const extTeamId = u.teams?.[0]?.teamId ?? null;
    const intTeamId = extTeamId ? (teamMap.get(extTeamId) ?? null) : null;
    let emp = await db.employee.findFirst({ where: { orgId, email, deletedAt: null } });
    if (!emp) {
      emp = await db.employee.create({ data: { id: randomUUID(), orgId, name: u.userName, email, roleId: roleMap['Employee'], ...(intTeamId ? { teamId: intTeamId } : {}), status:'active', workModeType:'Office', updatedAt: new Date() } });
      await db.clientAuth.create({ data: { id: randomUUID(), orgId, employeeId: emp.id, email, passwordHash: pwHash, updatedAt: new Date() } });
      console.log('Created employee:', u.userName);
    } else if (intTeamId && !emp.teamId) {
      await db.employee.update({ where: { id: emp.id }, data: { teamId: intTeamId, updatedAt: new Date() } });
    }
    const em = await db.agentEmployeeMapping.findFirst({ where: { orgId, externalUserId: u.userId } });
    if (!em) await db.agentEmployeeMapping.create({ data: { id: randomUUID(), employeeId: emp.id, orgId, agentProvider:'trackpilots', externalUserId: u.userId, externalTeamId: extTeamId } });
  }
  console.log('Done! Employees:', await db.employee.count({ where: { orgId } }), '| Teams:', await db.team.count({ where: { orgId } }));
}
run().catch(console.error).finally(() => db.$disconnect());
