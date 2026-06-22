import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

function checkAdmin(req) {
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${process.env.ADMIN_TOKEN || ''}`;
  return !!process.env.ADMIN_TOKEN && auth === expected;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  if (!checkAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  try {
    const body = req.body || {};
    const action = body.action === 'undo' ? 'undo' : 'add';
    const userId = body.userId;
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 40) : '';

    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const lockResult = await withDataLock(redis, async () => {
      const data = await redis.get(KEY);
      if (!data || !Array.isArray(data.users)) {
        return { status: 404, body: { ok: false, error: 'no data' } };
      }

      const user = data.users.find(u => u.id === userId);
      if (!user) {
        return { status: 404, body: { ok: false, error: 'user not found' } };
      }

      user.totalSpoon = Math.max(0, Math.floor(Number(user.totalSpoon) || 0));
      user.history = Array.isArray(user.history) ? user.history : [];

      if (action === 'undo') {
        if (user.history.length === 0) {
          return { status: 400, body: { ok: false, error: 'no donation history' } };
        }
        const last = user.history[user.history.length - 1];
        const amount = Math.max(0, Math.floor(Number(last.amount) || 0));
        user.history.pop();
        user.totalSpoon = Math.max(0, user.totalSpoon - amount);
        await redis.set(KEY, data);
        return {
          status: 200,
          body: {
            ok: true,
            action: 'undo',
            amount,
            totalSpoon: user.totalSpoon,
            historyCount: user.history.length,
          },
        };
      }

      const amount = Math.max(0, Math.floor(Number(body.amount) || 0));
      if (amount <= 0) {
        return { status: 400, body: { ok: false, error: 'amount must be positive' } };
      }

      user.totalSpoon += amount;
      user.history.push({
        amount,
        timestamp: Date.now(),
        note: note || undefined,
      });

      await redis.set(KEY, data);
      return {
        status: 200,
        body: {
          ok: true,
          action: 'add',
          amount,
          totalSpoon: user.totalSpoon,
          historyCount: user.history.length,
        },
      };
    });

    if (lockResult.busy) {
      return res.status(503).json({ ok: false, error: 'busy, retry' });
    }
    return res.status(lockResult.result.status).json(lockResult.result.body);
  } catch (e) {
    console.error('api/donate error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
