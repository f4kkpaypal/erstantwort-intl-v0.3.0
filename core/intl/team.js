'use strict';

const crypto = require('crypto');

const MAX_TEAM_MEMBERS = 5;
const ROLES = new Set(['viewer', 'editor']);
const ACTIVE = 'active';
const PENDING = 'pending';
const REVOKED = 'revoked';

function ensureTeamTable(store) {
  store.run(`CREATE TABLE IF NOT EXISTS i_team_member (
    owner_broker_id TEXT NOT NULL,
    member_telegram_id TEXT NOT NULL,
    role TEXT NOT NULL,
    invite_token_hash TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    accepted_at TEXT,
    PRIMARY KEY (owner_broker_id, member_telegram_id)
  )`);
}

function hashInviteToken(salt, token) {
  return crypto.createHmac('sha256', String(salt || '')).update(`team-invite:${token}`).digest('hex');
}

function makeInviteToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function normalizeTelegramId(value) {
  const id = String(value == null ? '' : value).trim();
  if (!/^\d{1,20}$/.test(id)) return '';
  return id;
}

function normalizeRole(value) {
  const role = String(value || 'viewer').trim().toLowerCase();
  return ROLES.has(role) ? role : 'viewer';
}

function rowPublic(row) {
  if (!row) return null;
  return {
    owner_broker_id: String(row.owner_broker_id),
    member_telegram_id: String(row.member_telegram_id),
    role: row.role,
    status: row.status,
    created_at: row.created_at || null,
    accepted_at: row.accepted_at || null,
  };
}

function getMembership(store, ownerId, memberId) {
  ensureTeamTable(store);
  return store.one(
    'SELECT * FROM i_team_member WHERE owner_broker_id = ? AND member_telegram_id = ?',
    [String(ownerId), String(memberId)],
  );
}

function activeMembership(store, ownerId, memberId) {
  const row = getMembership(store, ownerId, memberId);
  if (!row || row.status !== ACTIVE) return null;
  return rowPublic(row);
}

function listMembers(store, ownerId) {
  ensureTeamTable(store);
  return store.all(
    `SELECT * FROM i_team_member
     WHERE owner_broker_id = ? AND status IN (?, ?)
     ORDER BY created_at`,
    [String(ownerId), PENDING, ACTIVE],
  ).map(rowPublic);
}

function listWorkspaces(store, memberId) {
  ensureTeamTable(store);
  return store.all(
    `SELECT * FROM i_team_member
     WHERE member_telegram_id = ? AND status = ?
     ORDER BY accepted_at, created_at`,
    [String(memberId), ACTIVE],
  ).map(rowPublic);
}

function accessibleBrokerIds(store, userId) {
  const mine = String(userId);
  const ids = [mine];
  for (const row of listWorkspaces(store, mine)) {
    if (!ids.includes(row.owner_broker_id)) ids.push(row.owner_broker_id);
  }
  return ids;
}

function inviteMember(store, config, ownerId, body, nowIso) {
  ensureTeamTable(store);
  const owner = String(ownerId);
  const memberId = normalizeTelegramId(body && body.telegram_id);
  if (!memberId) return { ok: false, status: 400, error_code: 'bad_telegram_id' };
  if (memberId === owner) return { ok: false, status: 400, error_code: 'cannot_invite_self' };
  const role = normalizeRole(body && body.role);

  const existingActive = store.all(
    `SELECT member_telegram_id FROM i_team_member
     WHERE owner_broker_id = ? AND status IN (?, ?)`,
    [owner, PENDING, ACTIVE],
  );
  const already = existingActive.find((row) => String(row.member_telegram_id) === memberId);
  if (!already && existingActive.length >= MAX_TEAM_MEMBERS) {
    return { ok: false, status: 409, error_code: 'team_limit' };
  }

  const token = makeInviteToken();
  const tokenHash = hashInviteToken(config.HASH_SALT, token);
  const createdAt = nowIso || new Date().toISOString();
  store.run(
    `INSERT INTO i_team_member
       (owner_broker_id, member_telegram_id, role, invite_token_hash, status, created_at, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(owner_broker_id, member_telegram_id) DO UPDATE SET
       role = excluded.role,
       invite_token_hash = excluded.invite_token_hash,
       status = excluded.status,
       created_at = excluded.created_at,
       accepted_at = NULL`,
    [owner, memberId, role, tokenHash, PENDING, createdAt],
  );
  return {
    ok: true,
    telegram_id: memberId,
    role,
    status: PENDING,
    invite_token: token,
  };
}

function acceptInvite(store, config, userId, body, nowIso) {
  ensureTeamTable(store);
  const memberId = String(userId);
  const ownerId = normalizeTelegramId(body && body.owner_id);
  const token = String((body && body.token) || '').trim();
  if (!ownerId || !token) return { ok: false, status: 400, error_code: 'bad_invite' };
  if (ownerId === memberId) return { ok: false, status: 400, error_code: 'cannot_invite_self' };

  const row = getMembership(store, ownerId, memberId);
  if (!row || row.status === REVOKED) return { ok: false, status: 404, error_code: 'invite_not_found' };
  if (row.status === ACTIVE) {
    return { ok: true, already: true, membership: rowPublic(row) };
  }
  const expected = String(row.invite_token_hash || '');
  const got = hashInviteToken(config.HASH_SALT, token);
  if (!expected || expected.length !== got.length
    || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(got))) {
    return { ok: false, status: 403, error_code: 'bad_token' };
  }
  if (String(row.member_telegram_id) !== memberId) {
    return { ok: false, status: 403, error_code: 'wrong_member' };
  }

  const acceptedAt = nowIso || new Date().toISOString();
  store.run(
    `UPDATE i_team_member
     SET status = ?, accepted_at = ?, invite_token_hash = NULL
     WHERE owner_broker_id = ? AND member_telegram_id = ?`,
    [ACTIVE, acceptedAt, ownerId, memberId],
  );
  const membership = activeMembership(store, ownerId, memberId);
  return { ok: true, membership };
}

function revokeMember(store, ownerId, body) {
  ensureTeamTable(store);
  const owner = String(ownerId);
  const memberId = normalizeTelegramId(body && body.telegram_id);
  if (!memberId) return { ok: false, status: 400, error_code: 'bad_telegram_id' };
  const row = getMembership(store, owner, memberId);
  if (!row || row.status === REVOKED) return { ok: false, status: 404, error_code: 'not_found' };
  store.run(
    `UPDATE i_team_member
     SET status = ?, invite_token_hash = NULL
     WHERE owner_broker_id = ? AND member_telegram_id = ?`,
    [REVOKED, owner, memberId],
  );
  return { ok: true, telegram_id: memberId, status: REVOKED };
}

function teamSnapshot(store, userId) {
  ensureTeamTable(store);
  const id = String(userId);
  return {
    ok: true,
    members: listMembers(store, id),
    workspaces: listWorkspaces(store, id),
    max_members: MAX_TEAM_MEMBERS,
  };
}

function resolveWorkspace(store, userId, workspaceId) {
  const mine = String(userId);
  const requested = workspaceId == null || workspaceId === '' ? mine : String(workspaceId).trim();
  if (requested === mine) {
    return { ok: true, broker_id: mine, role: 'owner', can_write: true, workspace_owner_id: mine };
  }
  const member = activeMembership(store, requested, mine);
  if (!member) return { ok: false, status: 403, error_code: 'workspace_forbidden' };
  return {
    ok: true,
    broker_id: requested,
    role: member.role,
    can_write: member.role === 'editor',
    workspace_owner_id: requested,
  };
}

function accessToLead(store, leadBrokerId, userId, { write = false } = {}) {
  const mine = String(userId);
  const owner = leadBrokerId == null ? '' : String(leadBrokerId);
  if (!owner) return { ok: false, status: 404, error_code: 'not_found' };
  if (owner === mine) {
    return { ok: true, role: 'owner', can_write: true, workspace_owner_id: owner };
  }
  const member = activeMembership(store, owner, mine);
  if (!member) return { ok: false, status: 404, error_code: 'not_found' };
  if (write && member.role !== 'editor') {
    return { ok: false, status: 403, error_code: 'viewer_readonly' };
  }
  return {
    ok: true,
    role: member.role,
    can_write: member.role === 'editor',
    workspace_owner_id: owner,
  };
}

module.exports = {
  MAX_TEAM_MEMBERS,
  ensureTeamTable,
  hashInviteToken,
  makeInviteToken,
  normalizeTelegramId,
  normalizeRole,
  activeMembership,
  listMembers,
  listWorkspaces,
  accessibleBrokerIds,
  inviteMember,
  acceptInvite,
  revokeMember,
  teamSnapshot,
  resolveWorkspace,
  accessToLead,
};
