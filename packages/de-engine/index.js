'use strict';

module.exports = {
  ...require('../../core/pipeline'),
  ...require('../../core/anfrage'),
  ...require('../../core/portals'),
  ...require('../../core/prompts'),
  ...require('../../core/score'),
  ...require('../../core/slots'),
  ...require('../../core/template'),
  ...require('../../core/reply'),
  ...require('../../core/telegram'),
  ...require('../../core/crm'),
  server: require('../../engine/server'),
};
