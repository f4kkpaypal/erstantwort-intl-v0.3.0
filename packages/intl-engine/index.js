'use strict';

module.exports = {
  ...require('../../core/intl/service'),
  ...require('../../core/intl/analyze'),
  ...require('../../core/intl/score'),
  ...require('../../core/intl/readiness'),
  ...require('../../core/intl/matchProperty'),
  ...require('../../core/intl/brochure'),
  ...require('../../core/intl/calendar'),
  ...require('../../core/intl/options'),
  ...require('../../core/intl/slots'),
  ...require('../../core/intl/telegramSend'),
  ...require('../../core/intl/desk'),
  ...require('../../core/intl/notify'),
  ...require('../../core/intl/gemini'),
  ...require('../../core/intl/deepseek'),
  server: require('../../engine/intlServer'),
};
