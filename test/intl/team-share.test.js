'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../../core/config');
const { createIntl } = require('../../core/intl/service');
const { buildIntlServer } = require('../../engine/intlServer');
const { signInitData } = require('../../core/uiAuth');
const team = require('../../core/intl/team');

const BOT = '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function initDataFor(id) {
  return signInitData({
    auth_date: Math.floor(Date.now() / 1000),
    query_id: 'test-' + id,
    user: JSON.stringify({ id, first_name: 'U' + id }),
  }, BOT);
}

function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-team-'));
  const config = loadConfig({
    PRODUCT_MODE: 'intl',
    CHANNEL_MODE: 'sim',
    HASH_SALT: 'team-salt-value',
    TELEGRAM_BOT_TOKEN: BOT,
    TELEGRAM_ALLOWED_USER_IDS: '*',
    MULTI_USER: 'true',
    OWNER_TELEGRAM_ID: '42',
    DEMO_UI_NO_AUTH: 'false',
    DATA_DIR: dir,
    LLM_MODE: 'mock',
  });
  const intl = createIntl(config, { file: path.join(dir, 'intl.sqlite') });
  return { intl, server: buildIntlServer(config, intl), dir };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function call(port, id, pathname, options = {}) {
  const headers = {
    Authorization: `tma ${initDataFor(id)}`,
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function seedOwnerLead(intl) {
  await intl.ingest({
    channel: 'telegram',
    sender_id: 'client-1',
    sender_name: 'Client',
    text: 'Viewing tomorrow please',
    dedup_key: 'team-share-1',
    fixture: true,
    broker_id: '42',
    reply_target: '42',
  });
}

test('invite token is hashed and never stored plain', () => {
  const hash = team.hashInviteToken('salt', 'plain-token');
  assert.equal(hash.length, 64);
  assert.notEqual(hash, 'plain-token');
});

test('invite → accept → colleague sees owner leads; stranger does not', async () => {
  const { intl, server } = makeServer();
  const port = await listen(server);
  try {
    await seedOwnerLead(intl);

    const invite = await call(port, 42, '/v1/intl/team/invite', {
      method: 'POST',
      body: { telegram_id: '777', role: 'viewer' },
    });
    assert.equal(invite.status, 200);
    assert.equal(invite.body.ok, true);
    assert.ok(invite.body.invite_token);
    assert.equal(invite.body.status, 'pending');

    const badToken = await call(port, 777, '/v1/intl/team/accept', {
      method: 'POST',
      body: { owner_id: '42', token: 'wrong-token' },
    });
    assert.equal(badToken.status, 403);
    assert.equal(badToken.body.error_code, 'bad_token');

    const wrongMember = await call(port, 999, '/v1/intl/team/accept', {
      method: 'POST',
      body: { owner_id: '42', token: invite.body.invite_token },
    });
    assert.equal(wrongMember.status, 404);

    const accept = await call(port, 777, '/v1/intl/team/accept', {
      method: 'POST',
      body: { owner_id: '42', token: invite.body.invite_token },
    });
    assert.equal(accept.status, 200);
    assert.equal(accept.body.ok, true);
    assert.equal(accept.body.membership.role, 'viewer');

    const ownEmpty = await call(port, 777, '/v1/intl/leads');
    assert.equal(ownEmpty.status, 200);
    assert.equal(ownEmpty.body.leads.length, 0);

    const shared = await call(port, 777, '/v1/intl/leads?workspace=42');
    assert.equal(shared.status, 200);
    assert.equal(shared.body.leads.length, 1);
    assert.equal(shared.body.workspace_owner_id, '42');
    assert.equal(shared.body.can_write, false);

    const stranger = await call(port, 111, '/v1/intl/leads?workspace=42');
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error_code, 'workspace_forbidden');

    const team = await call(port, 777, '/v1/intl/team');
    assert.equal(team.status, 200);
    assert.equal(team.body.workspaces.length, 1);
    assert.equal(team.body.workspaces[0].owner_broker_id, '42');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});

test('viewer cannot send; editor can; revoke closes access', async () => {
  const { intl, server } = makeServer();
  const port = await listen(server);
  try {
    await seedOwnerLead(intl);
    const leads = intl.leads({ broker_id: '42' });
    const leadId = leads[0].id;

    const viewerInvite = await call(port, 42, '/v1/intl/team/invite', {
      method: 'POST',
      body: { telegram_id: '700', role: 'viewer' },
    });
    await call(port, 700, '/v1/intl/team/accept', {
      method: 'POST',
      body: { owner_id: '42', token: viewerInvite.body.invite_token },
    });

    const viewerSend = await call(port, 700, `/v1/intl/leads/${encodeURIComponent(leadId)}/send`, {
      method: 'POST',
      body: { text: 'Hello', manual: true, idempotency_key: 'viewer-1' },
    });
    assert.equal(viewerSend.status, 403);
    assert.equal(viewerSend.body.error_code, 'viewer_readonly');

    const editorInvite = await call(port, 42, '/v1/intl/team/invite', {
      method: 'POST',
      body: { telegram_id: '800', role: 'editor' },
    });
    await call(port, 800, '/v1/intl/team/accept', {
      method: 'POST',
      body: { owner_id: '42', token: editorInvite.body.invite_token },
    });

    const leadGet = await call(port, 800, `/v1/intl/leads/${encodeURIComponent(leadId)}`);
    assert.equal(leadGet.status, 200);
    assert.equal(leadGet.body.lead.can_write, true);

    const draft = await call(port, 800, `/v1/intl/leads/${encodeURIComponent(leadId)}/draft`, {
      method: 'PUT',
      body: { text: 'Editor draft for the client', manual: true },
    });
    assert.equal(draft.status, 200);
    assert.equal(draft.body.ok, true);

    const revoke = await call(port, 42, '/v1/intl/team/revoke', {
      method: 'POST',
      body: { telegram_id: '800' },
    });
    assert.equal(revoke.status, 200);

    const after = await call(port, 800, '/v1/intl/leads?workspace=42');
    assert.equal(after.status, 403);

    const leadGone = await call(port, 800, `/v1/intl/leads/${encodeURIComponent(leadId)}`);
    assert.equal(leadGone.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});

test('cannot invite self; team limit is five; UI strings exist', async () => {
  const { intl, server } = makeServer();
  const port = await listen(server);
  try {
    const self = await call(port, 42, '/v1/intl/team/invite', {
      method: 'POST',
      body: { telegram_id: '42', role: 'viewer' },
    });
    assert.equal(self.status, 400);
    assert.equal(self.body.error_code, 'cannot_invite_self');

    for (let i = 0; i < 5; i += 1) {
      const res = await call(port, 42, '/v1/intl/team/invite', {
        method: 'POST',
        body: { telegram_id: String(9000 + i), role: 'viewer' },
      });
      assert.equal(res.status, 200, `invite ${i}`);
    }
    const sixth = await call(port, 42, '/v1/intl/team/invite', {
      method: 'POST',
      body: { telegram_id: '9999', role: 'viewer' },
    });
    assert.equal(sixth.status, 409);
    assert.equal(sixth.body.error_code, 'team_limit');

    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'i18n', 'en.json'), 'utf8'));
    const ru = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'i18n', 'ru.json'), 'utf8'));
    assert.equal(en.teamTitle, 'Connect a colleague');
    assert.equal(ru.teamTitle, 'Подключить коллегу');
    assert.ok(en.teamCreate && ru.teamCreate);
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'ui-intl', 'app.js'), 'utf8');
    assert.match(app, /teamTitle/);
    assert.match(app, /\/v1\/intl\/team\/invite/);
    assert.match(app, /workspaceSelect/);
    const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', '007_intl_team.sql'), 'utf8');
    assert.match(migration, /i_team_member/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    intl.close();
  }
});
