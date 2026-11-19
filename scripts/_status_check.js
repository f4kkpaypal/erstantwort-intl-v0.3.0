'use strict';
const fs = require('fs');
const app = fs.readFileSync('ui-intl/app.js', 'utf8');
const srv = fs.readFileSync('engine/intlServer.js', 'utf8');
const svc = fs.readFileSync('core/intl/service.js', 'utf8');
const rows = [
  ['PhaseA WebApp', app.includes('initWebAppShell')],
  ['PhaseA timeline', app.includes('threadTimeline')],
  ['PhaseA demo gate', app.includes('demo_ui')],
  ['B search', app.includes('state.q') || /leads\?q=/.test(app)],
  ['B templates', app.includes('/v1/intl/templates')],
  ['B connect', app.includes('/v1/intl/connect')],
  ['B metrics', app.includes('/v1/intl/metrics')],
  ['B contacts', app.includes('/v1/intl/contacts')],
  ['B followups', app.includes('/v1/intl/followups')],
  ['B week', app.includes('weekMode')],
  ['API desk routes', srv.includes('/v1/intl/metrics') && srv.includes('/v1/intl/connect')],
  ['API no body keys', !srv.includes('body.apiKey')],
  ['svc desk', svc.includes("require('./desk')")],
  ['svc search', svc.includes('query.q')],
  ['svc attach', svc.includes('attachLinksFooter')],
  ['svc remind', svc.includes('remindBrokers')],
  ['desk.js', fs.existsSync('core/intl/desk.js')],
  ['notify.js', fs.existsSync('core/intl/notify.js')],
];
let ok = 0;
for (const [k, v] of rows) {
  console.log(`${v ? 'OK' : 'MISS'}  ${k}`);
  if (v) ok += 1;
}
console.log(`\n${ok}/${rows.length}`);
