const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const path = require('node:path');
const { passwordRecord } = require('./access');
const { readRecords, writeRecord } = require('./local-store');
const Avatars = require('./public/avatars');

const derive = promisify(scrypt);
const cookieName = 'river_account';
const lifetime = 12 * 3600_000;
const digits = value => typeof value === 'string' && /^[0-9]{1,128}$/.test(value);
const error = (status, message) => Object.assign(new Error(message), { status });
const profile = record => ({ uid: record.uid, name: record.name, avatar: record.avatar });

function clientAddress(req) {
  const address = req.socket.remoteAddress || 'unknown';
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  return local ? String(req.headers['cf-connecting-ip'] || address).slice(0, 64) : address;
}

class Accounts {
  constructor(root) {
    this.directory = path.join(root, 'accounts');
    this.byNumber = new Map();
    this.byUid = new Map();
    for (const record of readRecords(this.directory)) this.remember(record);
    this.sessions = new Map();
    this.attempts = new Map();
    this.dummy = passwordRecord(randomBytes(32).toString('hex'));
  }

  remember(record) {
    this.byNumber.set(record.number, record);
    this.byUid.set(record.uid, record);
  }

  save(record) {
    writeRecord(this.directory, record.uid, record);
    this.remember(record);
  }

  session(req, gateKey) {
    const token = (req.headers.cookie || '').match(/(?:^|;\s*)river_account=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const session = this.sessions.get(token);
    if (!session || session.gateKey !== gateKey || session.expires <= Date.now()) return null;
    return { token, uid: session.uid };
  }

  cookie(req, token = '') {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const secure = req.socket.encrypted || (local && String(req.headers['x-forwarded-proto']).split(',')[0].trim() === 'https');
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? lifetime / 1000 : 0}${secure ? '; Secure' : ''}`;
  }

  limit(req, number, operation) {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    const keys = [`${operation}:ip:${clientAddress(req)}`, `${operation}:account:${number}`];
    if (this.attempts.size >= 4096 || keys.some(key => (this.attempts.get(key)?.count || 0) >= 12)) {
      throw error(429, '尝试次数过多，请稍后再试');
    }
    for (const key of keys) {
      const entry = this.attempts.get(key) || { count: 0, until: now + 15 * 60_000 };
      entry.count++;
      this.attempts.set(key, entry);
    }
    return keys;
  }

  async register(req, { number, password, confirmation }) {
    if (!digits(number) || !digits(password) || confirmation !== password) throw error(400, '请输入数字账号和密码，并确认两次密码一致');
    this.limit(req, number, 'register');
    if (this.byNumber.has(number)) throw error(409, '该账号已注册');
    const credentials = await passwordRecord(password);
    if (this.byNumber.has(number)) throw error(409, '该账号已注册');
    const uid = randomUUID();
    const record = { uid, number, name: '玩家' + uid.slice(0, 5), avatar: 'default', credentials };
    this.save(record);
    return record;
  }

  async login(req, { number, password }) {
    if (!digits(number) || !digits(password)) throw error(400, '请输入数字账号和密码');
    const keys = this.limit(req, number, 'login');
    const record = this.byNumber.get(number);
    if (!await this.matches(password, record?.credentials || await this.dummy) || !record ||
        this.byUid.get(record.uid)?.credentials !== record.credentials) throw error(401, '账号或密码错误');
    for (const key of keys) this.attempts.delete(key);
    return this.byUid.get(record.uid);
  }

  async matches(password, credentials) {
    return timingSafeEqual(await derive(password, credentials.salt, 64), Buffer.from(credentials.hash, 'hex'));
  }

  issue(record, gateKey) {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expires <= now) this.sessions.delete(token);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { uid: record.uid, gateKey, expires: now + lifetime });
    return token;
  }

  update(uid, values) {
    const record = this.byUid.get(uid);
    const name = values.name === undefined ? record.name : typeof values.name === 'string' ? values.name.trim() : '';
    const avatar = values.avatar === undefined ? record.avatar : values.avatar;
    if (!name || name.length > 32 || !Avatars.valid(avatar)) throw error(400, '昵称须为1至32个字符，并选择有效头像');
    const updated = { ...record, name, avatar };
    this.save(updated);
    return profile(updated);
  }

  async changePassword(req, uid, { current, password, confirmation }) {
    const record = this.byUid.get(uid);
    if (!digits(current) || !digits(password) || password !== confirmation) throw error(400, '请输入当前密码和两次相同的新数字密码');
    const keys = this.limit(req, record.number, 'password');
    if (!await this.matches(current, record.credentials)) throw error(401, '当前密码错误');
    const credentials = await passwordRecord(password);
    const latest = this.byUid.get(uid);
    if (latest.credentials !== record.credentials) throw error(409, '密码已修改，请重新登录');
    this.save({ ...latest, credentials });
    for (const key of keys) this.attempts.delete(key);
  }

  async resetPassword(number, password, confirmation) {
    const record = this.byNumber.get(number);
    if (!record) throw error(404, '账号不存在');
    if (!digits(password) || password !== confirmation) throw error(400, '请输入两次相同的数字密码');
    const credentials = await passwordRecord(password);
    this.save({ ...this.byUid.get(record.uid), credentials });
  }
}

module.exports = { Accounts, error, profile };
