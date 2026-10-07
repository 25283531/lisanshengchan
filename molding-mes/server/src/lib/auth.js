/** 密码散列与 JWT（HS256，仅用 node:crypto，不引第三方） */
import { randomBytes, scryptSync, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import config from '../config.js';

const KEYLEN = 64;

export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(plain), salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || !plain) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  try {
    const calc = scryptSync(String(plain), salt, KEYLEN);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && timingSafeEqual(calc, expect);
  } catch {
    return false;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt(payload, ttlHours = config.tokenTtlHours) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + Math.floor(ttlHours * 3600) };
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(body));
  const sig = createHmac('sha256', config.jwtSecret).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${sig}`;
}

export function verifyJwt(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const expect = createHmac('sha256', config.jwtSecret).update(`${h}.${b}`).digest('base64url');
  if (sig.length !== expect.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** 短信验证码（演示模式返回明文；生产应接短信网关） */
export function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
