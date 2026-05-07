// /api/pull
// リスナーが指定タイプのガチャを引く
// body: { userId, gachaTypeId }
// 抽選はサーバ側で行うのでクライアント改ざん不可
import { Redis } from '@upstash/redis';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

function availableSpoon(user) {
  return Math.max(0, (user.totalSpoon || 0) - (user.spentSpoon || 0));
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
    const { userId, gachaTypeId } = req.body || {};
    if (!userId)      return res.status(400).json({ ok: false, error: 'userId required' });
    if (!gachaTypeId) return res.status(400).json({ ok: false, error: 'gachaTypeId required' });

    const data = await redis.get(KEY);
    if (!data || !Array.isArray(data.users)) {
      return res.status(404).json({ ok: false, error: 'no data' });
    }

    const user = data.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ ok: false, error: 'user not found' });

    const types = (data.settings && data.settings.gachaTypes) || [];
    const type = types.find(t => t.id === gachaTypeId);
    if (!type) return res.status(404).json({ ok: false, error: 'gacha type not found' });

    const cost = Number(type.cost) || 0;
    if (cost <= 0) return res.status(400).json({ ok: false, error: 'invalid cost' });

    if (availableSpoon(user) < cost) {
      return res.status(400).json({ ok: false, error: 'not enough spoon' });
    }

    const prize = rollPrize(type.prizes);
    if (!prize) return res.status(400).json({ ok: false, error: 'no prizes configured' });

    // ユーザーに記録（Spoon 消費 + 履歴追記）
    user.spentSpoon = (user.spentSpoon || 0) + cost;
    user.gachaHistory = user.gachaHistory || [];
    user.gachaHistory.push({
      gachaTypeId: type.id,
      gachaTypeName: type.name,
      cost,
      prizeId: prize.id,
      prizeName: prize.name,
      rarity: prize.rarity || 'N',
      prizeIcon: prize.icon || '',
      prizeIconType: prize.iconType || 'emoji',
      timestamp: Date.now(),
    });

    await redis.set(KEY, data);
    return res.status(200).json({ ok: true, prize, spentSpoon: user.spentSpoon });
  } catch (e) {
    console.error('api/pull error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
