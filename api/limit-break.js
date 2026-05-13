// /api/limit-break
// 同じ景品の重複インスタンスを1個消費して限界突破段階を1つ上げる。
// body: { userId, instanceId }
//   instanceId は表示の対象になる景品の任意のインスタンス。実際の消費は「別」のインスタンス。
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';
import {
  ensureUserInventory,
  sanitizeAllTradeIcons,
  findOtherInstanceOfSamePrize,
  ensureLimitBreaks,
} from '../lib/inventory.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();
const DEFAULT_LIMIT_BREAK_MAX = 4;

async function processLimitBreak(body, data) {
  const { userId, instanceId } = body;
  if (!instanceId) return { status: 400, body: { ok: false, error: 'instanceId required' }, save: false };

  const user = (data.users || []).find(u => u.id === userId);
  if (!user) return { status: 404, body: { ok: false, error: 'user not found' }, save: false };

  ensureUserInventory(user);
  ensureLimitBreaks(user);

  const targetItem = user.inventory.find(it => it.instanceId === instanceId);
  if (!targetItem) return { status: 404, body: { ok: false, error: 'instance not in inventory' }, save: false };

  const prizeKey = `${targetItem.gachaTypeId}::${targetItem.prizeId}`;
  const max = Math.max(1, Math.floor(Number(data.settings && data.settings.limitBreakMax) || DEFAULT_LIMIT_BREAK_MAX));
  const current = Math.max(0, Math.floor(Number(user.limitBreaks[prizeKey]) || 0));
  if (current >= max) {
    return { status: 400, body: { ok: false, error: 'max reached' }, save: false };
  }

  // 出品中・オファー中のインスタンスを先に集計（素材選択時に避けるため）
  const trades = Array.isArray(data.trades) ? data.trades : [];
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

  // 別インスタンス（target 自身でなく、トレードロックされていない）を素材として選ぶ。
  // 古い方を優先（acquiredAt 昇順）。
  const candidates = user.inventory
    .filter(it => it.instanceId !== instanceId
      && it.gachaTypeId === targetItem.gachaTypeId
      && it.prizeId === targetItem.prizeId
      && !lockedIds.has(it.instanceId))
    .sort((a, b) => (a.acquiredAt || 0) - (b.acquiredAt || 0));
  if (candidates.length === 0) {
    // 重複自体が無いのか、全部ロックされているのかを区別してエラーを返す
    const anyDup = findOtherInstanceOfSamePrize(user, instanceId, targetItem.gachaTypeId, targetItem.prizeId);
    if (!anyDup) {
      return { status: 400, body: { ok: false, error: 'need duplicate' }, save: false };
    }
    return { status: 400, body: { ok: false, error: 'material listed in trade' }, save: false };
  }
  const material = candidates[0];

  // 消費＆突破
  user.inventory = user.inventory.filter(it => it.instanceId !== material.instanceId);
  user.limitBreaks[prizeKey] = current + 1;

  return {
    status: 200,
    body: {
      ok: true,
      prizeKey,
      newLevel: user.limitBreaks[prizeKey],
      consumedInstanceId: material.instanceId,
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
      const result = await processLimitBreak(body, data);
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
    console.error('api/limit-break error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
