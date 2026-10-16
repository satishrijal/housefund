'use strict';
/**
 * auth.js — scrypt password hashing (zero-dep) + session tokens.
 * Admin identity comes from ADMIN_USER / ADMIN_PASS env vars.
 */
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const [, salt, hash] = parts;
    const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
  } catch { return false; }
}

function newToken() { return crypto.randomBytes(32).toString('hex'); }

function tempPassword() {
  const words = ['mango', 'river', 'tiger', 'cloud', 'pepper', 'sunny', 'coconut', 'baker'];
  const w = () => words[crypto.randomInt(words.length)];
  return `${w()}-${w()}-${crypto.randomInt(100, 999)}`;
}

function adminUser() { return process.env.ADMIN_USER || 'admin'; }
function adminConfigured() { return !!process.env.ADMIN_PASS; }
function verifyAdmin(user, pass) {
  if (!process.env.ADMIN_PASS) return false;
  return String(user) === adminUser() &&
    crypto.timingSafeEqual(Buffer.from(String(pass)), Buffer.from(process.env.ADMIN_PASS));
}

module.exports = { hashPassword, verifyPassword, newToken, tempPassword, adminUser, adminConfigured, verifyAdmin };
