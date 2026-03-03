'use strict';

/**
 * AES-256-GCM encryption helpers.
 * CONFIG_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

const crypto = require('crypto');

const ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || '';
const MASKED = '••••••••';

function validateKey() {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 64) {
    throw new Error('CONFIG_ENCRYPTION_KEY must be a 64-char hex string');
  }
}

function encrypt(plaintext) {
  validateKey();
  const iv      = crypto.randomBytes(16);
  const key     = Buffer.from(ENCRYPTION_KEY, 'hex');
  const cipher  = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc       = cipher.update(plaintext, 'utf8', 'hex');
  enc          += cipher.final('hex');
  const tag     = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}

function decrypt(encryptedStr) {
  validateKey();
  const [ivHex, tagHex, enc] = encryptedStr.split(':');
  const iv      = Buffer.from(ivHex, 'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const key     = Buffer.from(ENCRYPTION_KEY, 'hex');
  const d       = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  let out = d.update(enc, 'hex', 'utf8');
  out    += d.final('utf8');
  return out;
}

function isMasked(value) {
  return !value || value.includes('•');
}

module.exports = { encrypt, decrypt, isMasked, MASKED };
