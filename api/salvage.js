// /api/salvage
// 所持景品を分解してガチャポイントに変換する。
// 複数 instanceId を一括処理（部分成功はせず、1つでも違反があれば全体エラー）。
//
// body: { userId, instanceIds: [...] }
// 返り値: { ok, totalPoint, breakdown: { N, R, SR, SSR, UR }, newGachaPoint }
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';
import {
  ensureUserInventory,
  sanitizeAllTradeIcons,
  getRarityForInstance,
} from '../lib/inventory.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

const DEFAULT_RATES = { N: 10, R: 25, SR: 50, SSR: 100, UR: 500 };

function pickRate(rates, rarity) {
  const r = String(rarity || 'N').toUpperCase();
  const tbl = (rates && typeof rates === 'object') ? rates : {};
  const v = tbl[r];
  if (typeof v === 'number' && v >= 0) return Math.floor(v);
  const def = DEFAULT_RATES[r];
  return typeof def === 'number' ? def : 0;
}

async function processSalvage(body, data) {
  const { userId, instanceIds } = body;
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    return { status: 400, body: { ok: false, error: 'instanceIds required' }, save: false };
  }

  const user = (data.users || []).find(u => u.id === userId);
  if (!user) return { status: 404, body: { ok: false, error: 'user not found' }, save: false };

  ensureUserInventory(user);

  const types = (data.settings && data.settings.gachaTypes) || [];
  const rates = (data.settings && data.settings.salvageRates) || DEFAULT_RATES;
  const trades = Array.isArray(data.trades) ? data.trades : [];

  // 出品中・オファー中のインスタンスを集める
  const lockedIds = new Set();
  for (const t of trades) {
    if (t.status !== 'open') continue;
    if (t.ownerId === userId && t.ownerItem && t.ownerItem.instanceId) {
      lockedIds.add(t.ownerItem.instanceId);
    }
    if (Array.isArray(t.offers)) {
      for (const o of t.offers) {
        if (o.offererId === userId && o.status === 'pending' && o.item && o.item.instanceId) {
          lockedIds.add(o.item.instanceId);
        }
      }
    }
  }

  // 重複排除して検証
  const ids = Array.from(new Set(instanceIds));
  const invalidNotOwned = [];
  const invalidListed = [];
  const targets = [];
  for (const id of ids) {
    const it = user.inventory.find(x => x.instanceId === id);
    if (!it) { invalidNotOwned.push(id); continue; }
    if (lockedIds.has(id)) { invalidListed.push(id); continue; }
    targets.push(it);
  }
  if (invalidNotOwned.length > 0 || invalidListed.length > 0) {
    return {
      status: 400,
      body: {
        ok: false,
        error: 'some instances invalid',
        notOwned: invalidNotOwned,
        listed: invalidListed,
      },
      save: false,
    };
  }

  // レアリティ別カウントと合計ポイントを計算
  const breakdown = { N: 0, R: 0, SR: 0, SSR: 0, UR: 0 };
  let totalPoint = 0;
  for (const item of targets) {
    const rarity = getRarityForInstance(item, types, user.gachaHistory);
    const r = (breakdown[rarity] !== undefined) ? rarity : 'N';
    breakdown[r] = (breakdown[r] || 0) + 1;
    totalPoint += pickRate(rates, r);
  }

  // inventory から該当 instance を削除
  const removeIds = new Set(targets.map(t => t.instanceId));
  user.inventory = user.inventory.filter(it => !removeIds.has(it.instanceId));

  user.gachaPoint = Math.max(0, Math.floor(Number(user.gachaPoint) || 0)) + totalPoint;

  // 履歴に分解記録（任意）
  if (!Array.isArray(user.salvageHistory)) user.salvageHistory = [];
  user.salvageHistory.push({
    timestamp: Date.now(),
    count: targets.length,
    totalPoint,
    breakdown: { ...breakdown },
  });
  // 履歴は最新 50 件のみ保持
  if (user.salvageHistory.length > 50) {
    user.salvageHistory = user.salvageHistory.slice(-50);
  }

  return {
    status: 200,
    body: {
      ok: true,
      totalPoint,
      breakdown,
      newGachaPoint: user.gachaPoint,
    },
    save: true,
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  try {
    const body = req.body || {};
    if (!body.userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const lockResult = await withDataLock(redis, async () => {
      const data = await redis.get(KEY);
      if (!data || !Array.isArray(data.users)) {
        return { status: 404, body: { ok: false, error: 'no data' }, save: false };
      }
      const result = await processSalvage(body, data);
      if (result.save) {
        sanitizeAllTradeIcons(data);
        await redis.set(KEY, data);
      }
      return result;
    });
    if (lockResult.busy) {
      return res.status(503).json({ ok: false, error: 'busy, retry' });
    }
    const { status, body: resBody } = lockResult.result;
    return res.status(status).json(resBody);
  } catch (e) {
    console.error('api/salvage error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
