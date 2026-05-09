// /api/pull
// 参加者が指定タイプのガチャを引く（単発 or 連、天井機能付き）
// body: { userId, gachaTypeId, count? }
//   count=1（省略時）：単発
//   count>1: gachaType.multiPullCount と一致する場合のみ受理（任意の数値はNG）
//
// 天井：gachaType.pityCount > 0 かつ gachaType.pityPrize がある場合、
// user.pityCounts[gachaTypeId] が pityCount に達したら抽選結果を pityPrize に差し替えてカウンタを0にリセット。
// 連ガチャ中でも各ロールごとに判定されるため、連の途中で天井を踏むケースに対応。
//
// 並行実行による spentSpoon / gachaHistory の競合を防ぐため、Redis 分散ロックで GET-MODIFY-SET を直列化。
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';

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

function isValidPityPrize(p) {
  return p && typeof p === 'object' && typeof p.name === 'string' && p.name.length > 0;
}

function isBase64Image(v) {
  return typeof v === 'string' && v.startsWith('data:image');
}

// 容量肥大対策：景品の base64 画像はガチャ履歴に保存しない（gachaTypes 側に1つだけ残す）。
// 表示時は prizeId/gachaTypeId から resolve させる。
function thinIcon(icon) {
  return isBase64Image(icon) ? '' : (icon || '');
}

// 既存の履歴に残っている base64 画像も全ユーザーぶん削除（一度だけ走ればOK）
function sanitizeAllGachaHistory(data) {
  if (!data || !Array.isArray(data.users)) return;
  for (const u of data.users) {
    if (!Array.isArray(u.gachaHistory)) continue;
    for (const h of u.gachaHistory) {
      if (isBase64Image(h.prizeIcon)) {
        h.prizeIcon = '';
      }
    }
  }
}

// ロック内で実行される本体ロジック。
// 戻り値：{ status: number, body: object }
async function processPull({ userId, gachaTypeId, count }) {
  const data = await redis.get(KEY);
  if (!data || !Array.isArray(data.users)) {
    return { status: 404, body: { ok: false, error: 'no data' } };
  }

  const user = data.users.find(u => u.id === userId);
  if (!user) return { status: 404, body: { ok: false, error: 'user not found' } };

  const types = (data.settings && data.settings.gachaTypes) || [];
  const type = types.find(t => t.id === gachaTypeId);
  if (!type) return { status: 404, body: { ok: false, error: 'gacha type not found' } };

  const cost = Number(type.cost) || 0;
  if (cost <= 0) return { status: 400, body: { ok: false, error: 'invalid cost' } };

  const multiCount = Math.max(0, Math.floor(Number(type.multiPullCount) || 0));
  const requestedCount = Math.max(1, Math.floor(Number(count) || 1));
  if (requestedCount !== 1 && requestedCount !== multiCount) {
    return { status: 400, body: { ok: false, error: 'invalid count' } };
  }
  if (requestedCount > 1 && multiCount < 2) {
    return { status: 400, body: { ok: false, error: 'multi-pull not enabled' } };
  }

  const totalCost = cost * requestedCount;
  if (availableSpoon(user) < totalCost) {
    return { status: 400, body: { ok: false, error: 'not enough pt' } };
  }

  // 天井設定
  const pityThreshold = Math.max(0, Math.floor(Number(type.pityCount) || 0));
  const pityEnabled = pityThreshold > 0 && isValidPityPrize(type.pityPrize);
  user.pityCounts = user.pityCounts || {};
  let pityCounter = Math.max(0, Math.floor(Number(user.pityCounts[type.id]) || 0));

  // 抽選を requestedCount 回実行
  const prizes = [];
  for (let i = 0; i < requestedCount; i++) {
    pityCounter += 1;
    let prize;
    let isPity = false;
    if (pityEnabled && pityCounter >= pityThreshold) {
      prize = {
        id: type.pityPrize.id || ('pity-' + type.id),
        name: type.pityPrize.name,
        rarity: type.pityPrize.rarity || 'UR',
        icon: type.pityPrize.icon || '🏆',
        iconType: type.pityPrize.iconType || 'emoji',
        description: type.pityPrize.description || '',
      };
      isPity = true;
      pityCounter = 0;
    } else {
      prize = rollPrize(type.prizes);
      if (!prize) return { status: 400, body: { ok: false, error: 'no prizes configured' } };
    }
    prizes.push({ ...prize, isPity });
  }

  // ユーザーに記録（pt 消費 + 履歴追記 + 天井カウンタ更新）
  user.spentSpoon = (user.spentSpoon || 0) + totalCost;
  user.gachaHistory = user.gachaHistory || [];
  user.pityCounts[type.id] = pityCounter;
  const now = Date.now();
  for (const p of prizes) {
    user.gachaHistory.push({
      gachaTypeId: type.id,
      gachaTypeName: type.name,
      cost,
      prizeId: p.id,
      prizeName: p.name,
      rarity: p.rarity || 'N',
      // base64 画像は容量肥大の元なので履歴に保存しない（表示時に gachaTypes から resolve）
      prizeIcon: thinIcon(p.icon),
      prizeIconType: p.iconType || 'emoji',
      isPity: !!p.isPity,
      timestamp: now,
    });
  }

  // 既存履歴の base64 画像も同時に掃除（10MB制限対策の一回限りマイグレーション）
  sanitizeAllGachaHistory(data);

  await redis.set(KEY, data);
  return {
    status: 200,
    body: {
      ok: true,
      prize: prizes[0],
      prizes,
      count: requestedCount,
      totalCost,
      spentSpoon: user.spentSpoon,
      pityCounter,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  try {
    const { userId, gachaTypeId, count } = req.body || {};
    if (!userId)      return res.status(400).json({ ok: false, error: 'userId required' });
    if (!gachaTypeId) return res.status(400).json({ ok: false, error: 'gachaTypeId required' });

    // 分散ロックで GET-MODIFY-SET を直列化（同時実行による spentSpoon / gachaHistory の競合を防止）
    const lockResult = await withDataLock(redis, () => processPull({ userId, gachaTypeId, count }));
    if (lockResult.busy) {
      return res.status(503).json({ ok: false, error: 'busy, retry' });
    }
    const { status, body } = lockResult.result;
    return res.status(status).json(body);
  } catch (e) {
    console.error('api/pull error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
