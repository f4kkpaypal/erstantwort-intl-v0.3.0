'use strict';

// Strict credential validation shared by the HTTP layer, the WhatsApp connector and the boot guard.
// Every function returns a typed result and never echoes the secret back in the error message.

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {string} [error] Machine-readable error code.
 * @property {string} [field] Which input field failed.
 */

/** @param {unknown} value @returns {string} */
function text(value) {
  return String(value == null ? '' : value).trim();
}

/** @param {unknown} value @returns {boolean} */
function isTelegramToken(value) {
  return /^\d{5,}:[A-Za-z0-9_-]{25,}$/.test(text(value));
}

/** @param {unknown} value @returns {boolean} */
function isGreenInstance(value) {
  return /^\d{3,20}$/.test(text(value));
}

/** @param {unknown} value @returns {boolean} */
function isGreenToken(value) {
  return /^[A-Za-z0-9_-]{16,128}$/.test(text(value));
}

/** @param {unknown} value @returns {boolean} */
function isCloudToken(value) {
  return /^[A-Za-z0-9._-]{20,}$/.test(text(value));
}

/** @param {unknown} value @returns {boolean} */
function isCloudPhoneId(value) {
  return /^\d{5,20}$/.test(text(value));
}

/** @param {unknown} value @returns {boolean} */
function isVerifyToken(value) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(text(value));
}

/** @param {unknown} value @returns {boolean} */
function isAppSecret(value) {
  return /^[A-Za-z0-9]{16,64}$/.test(text(value));
}

/**
 * @param {{ id_instance?: unknown, api_token?: unknown }} input
 * @returns {ValidationResult}
 */
function validateGreenCredentials(input) {
  if (!isGreenInstance(input.id_instance)) return { ok: false, error: 'invalid_credentials', field: 'id_instance' };
  if (!isGreenToken(input.api_token)) return { ok: false, error: 'invalid_credentials', field: 'api_token' };
  return { ok: true };
}

/**
 * @param {{ cloud_token?: unknown, cloud_phone_id?: unknown, cloud_verify?: unknown, cloud_secret?: unknown }} input
 * @returns {ValidationResult}
 */
function validateCloudCredentials(input) {
  if (!isCloudToken(input.cloud_token)) return { ok: false, error: 'invalid_credentials', field: 'access_token' };
  if (!isCloudPhoneId(input.cloud_phone_id)) return { ok: false, error: 'invalid_credentials', field: 'phone_number_id' };
  if (!isVerifyToken(input.cloud_verify)) return { ok: false, error: 'invalid_credentials', field: 'verify_token' };
  if (!isAppSecret(input.cloud_secret)) return { ok: false, error: 'invalid_credentials', field: 'app_secret' };
  return { ok: true };
}

/**
 * Validate a gateway connect payload from the Mini App.
 * @param {{ gateway?: unknown, id_instance?: unknown, api_token?: unknown, cloud_token?: unknown, cloud_phone_id?: unknown, cloud_verify?: unknown, cloud_secret?: unknown }} body
 * @returns {{ ok: boolean, gateway?: 'green' | 'cloud', error?: string, field?: string }}
 */
function validateGatewayPayload(body) {
  const gateway = body.gateway === 'cloud' ? 'cloud' : body.gateway === 'green' ? 'green' : '';
  if (!gateway) return { ok: false, error: 'invalid_gateway' };
  const checked = gateway === 'green' ? validateGreenCredentials(body) : validateCloudCredentials(body);
  if (!checked.ok) return { ok: false, error: checked.error, field: checked.field };
  return { ok: true, gateway };
}

module.exports = {
  isTelegramToken,
  isGreenInstance,
  isGreenToken,
  isCloudToken,
  isCloudPhoneId,
  isVerifyToken,
  isAppSecret,
  validateGreenCredentials,
  validateCloudCredentials,
  validateGatewayPayload,
};
