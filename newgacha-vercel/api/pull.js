// /api/pull
// リスナー側からガチャを実行するエンドポイント
// 抽選はサーバ側で行うので、クライアント改ざんでレア排出を吊り上げられない
import { Redis } from '@upstash/redis';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

function gachaRights(user, threshold) {
  if (!threshold || threshold <= 0) return { earned: 0, consumed: 0, remaining: 0 };
  const earned = Math.floor((user.totalSpoon || 0) / threshold);
  const consumed = user.gachaConsumed || 0;
  return { earned, consumed, remaining: Math.max(0, earned - consumed) };
}

function rollPrize(prizes) {
  const valid = (prizes || []).filter(p => (p.weight || 0) > 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((s, p) => s + (p.weight || 0), 0);
  let r = Math.random() * total;
  for (const p of valid) {
    r -= (p.weight || 0);
    if (r <= 0) return p;
  }
  return valid[valid.length - 1];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const data = await redis.get(KEY);
    if (!data || !Array.isArray(data.users)) {
      return res.status(404).json({ ok: false, error: 'no data' });
    }

    const user = data.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });

    const rights = gachaRights(user, data.settings.gachaThreshold);
    if (rights.remaining <= 0) {
      return res.status(400).json({ ok: false, error: 'no gacha rights' });
    }

    const prize = rollPrize(data.settings.gachaPrizes);
    if (!prize) return res.status(400).json({ ok: false, error: 'no prizes configured' });

    // ユーザーに記録
    user.gachaConsumed = (user.gachaConsumed || 0) + 1;
    user.gachaHistory = user.gachaHistory || [];
    user.gachaHistory.push({
      prizeId: prize.id,
      prizeName: prize.name,
      rarity: prize.rarity || 'N',
      prizeIcon: prize.icon || '',
      prizeIconType: prize.iconType || 'emoji',
      timestamp: Date.now(),
    });

    await redis.set(KEY, data);
    return res.status(200).json({ ok: true, prize });
  } catch (e) {
    console.error('api/pull error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
