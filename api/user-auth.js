// /api/user-auth
// ユーザー（参加者）のパスワード設定 / ログイン用エンドポイント
// passwordHash はクライアントへ返さない（サーバー内に閉じる）
//
// body: { userId, action, password? }
//   action='check'  : パスワード設定済みかどうかだけ返す（認証不要）
//   action='set'    : 未設定のユーザーに4桁パスワードを設定（認証不要・初回のみ）
//   action='login'  : パスワード検証（認証不要）
//   action='reset'  : 管理者がパスワードをリセット（Bearer ADMIN_TOKEN 必須）
import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function hashPassword(password, salt) {
  // 4桁パスワードはそもそも総当たりに弱いが、せめてDB流出時の保護として salt+sha256
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  try {
    const { userId, action, password } = req.body || {};
    if (!userId || !action) {
      return res.status(400).json({ ok: false, error: 'userId and action required' });
    }

    const data = await redis.get(KEY);
    if (!data || !Array.isArray(data.users)) {
      return res.status(404).json({ ok: false, error: 'no data' });
    }
    const user = data.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });

    if (action === 'check') {
      return res.status(200).json({ ok: true, hasPassword: !!user.passwordHash });
    }

    if (action === 'set') {
      if (user.passwordHash) {
        return res.status(400).json({ ok: false, error: 'password already set' });
      }
      if (typeof password !== 'string' || !/^\d{4}$/.test(password)) {
        return res.status(400).json({ ok: false, error: 'invalid password format' });
      }
      user.passwordSalt = makeSalt();
      user.passwordHash = hashPassword(password, user.passwordSalt);
      await redis.set(KEY, data);
      return res.status(200).json({ ok: true });
    }

    if (action === 'login') {
      if (!user.passwordHash || !user.passwordSalt) {
        return res.status(400).json({ ok: false, error: 'password not set' });
      }
      if (typeof password !== 'string') {
        return res.status(400).json({ ok: false, error: 'password required' });
      }
      const hash = hashPassword(password, user.passwordSalt);
      if (hash !== user.passwordHash) {
        return res.status(401).json({ ok: false, error: 'wrong password' });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'reset') {
      // 管理者のみ
      const auth = req.headers['authorization'] || '';
      const expected = `Bearer ${process.env.ADMIN_TOKEN || ''}`;
      if (!process.env.ADMIN_TOKEN || auth !== expected) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      delete user.passwordHash;
      delete user.passwordSalt;
      await redis.set(KEY, data);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'invalid action' });
  } catch (e) {
    console.error('api/user-auth error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
