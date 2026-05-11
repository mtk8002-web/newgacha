// /api/trade
// トレード掲示板のCRUDエンドポイント。すべて分散ロック内でアトミックに処理。
//
// body: { action, userId, ... }
//   action='list'     : { instanceId, comment? } 自分の所持品を出品
//   action='cancel'   : { tradeId } 自分の出品を取り下げ
//   action='offer'    : { tradeId, instanceId } 他人の出品にオファー
//   action='withdraw' : { tradeId, offerId } 自分のオファーを取り下げ
//   action='accept'   : { tradeId, offerId } 出品者がオファーを承認 → 交換成立
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';
import { ensureAllInventories, snapshotPrize, thinIcon, sanitizeAllTradeIcons } from '../lib/inventory.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

function newTradeId() { return 'trade-' + Math.random().toString(36).slice(2, 10); }
function newOfferId() { return 'offer-' + Math.random().toString(36).slice(2, 10); }

const okResp = (body) => ({ status: 200, body: { ok: true, ...body }, save: true });
const errResp = (status, msg, save = false) => ({ status, body: { ok: false, error: msg }, save });

function findInventoryIndex(user, instanceId) {
  if (!Array.isArray(user.inventory)) return -1;
  return user.inventory.findIndex(it => it.instanceId === instanceId);
}

async function processTrade(body, data) {
  const { action, userId } = body;
  ensureAllInventories(data);
  data.trades = Array.isArray(data.trades) ? data.trades : [];

  const me = data.users.find(u => u.id === userId);
  if (!me) return errResp(404, 'user not found');

  if (action === 'list') {
    const { instanceId, comment } = body;
    if (!instanceId) return errResp(400, 'instanceId required');
    const idx = findInventoryIndex(me, instanceId);
    if (idx < 0) return errResp(404, 'instance not in inventory');
    // 同じインスタンスを2重に出品させない
    const dup = data.trades.find(t => t.status === 'open' && t.ownerItem && t.ownerItem.instanceId === instanceId);
    if (dup) return errResp(400, 'already listed');
    const item = me.inventory[idx];
    const types = (data.settings && data.settings.gachaTypes) || [];
    const trade = {
      id: newTradeId(),
      status: 'open',
      ownerId: userId,
      ownerName: me.name,
      // ユーザーアイコンの base64 は容量肥大の元なので保存しない（表示時に users から resolve）
      ownerIcon: thinIcon(me.icon),
      ownerIconType: me.iconType || 'emoji',
      ownerItem: { ...item, snapshot: snapshotPrize(item, types) },
      comment: (typeof comment === 'string' ? comment : '').slice(0, 200),
      offers: [],
      createdAt: Date.now(),
    };
    data.trades.push(trade);
    return okResp({ tradeId: trade.id });
  }

  if (action === 'cancel') {
    const trade = data.trades.find(t => t.id === body.tradeId);
    if (!trade) return errResp(404, 'trade not found');
    if (trade.ownerId !== userId) return errResp(403, 'not owner');
    if (trade.status !== 'open') return errResp(400, 'trade not open');
    trade.status = 'cancelled';
    trade.cancelledAt = Date.now();
    // すべての pending オファーを取り下げ扱いに
    for (const o of (trade.offers || [])) {
      if (o.status === 'pending') o.status = 'rejected';
    }
    return okResp({});
  }

  if (action === 'offer') {
    const trade = data.trades.find(t => t.id === body.tradeId);
    if (!trade) return errResp(404, 'trade not found');
    if (trade.status !== 'open') return errResp(400, 'trade not open');
    if (trade.ownerId === userId) return errResp(400, 'cannot offer on own trade');
    if (!body.instanceId) return errResp(400, 'instanceId required');
    const idx = findInventoryIndex(me, body.instanceId);
    if (idx < 0) return errResp(404, 'instance not in inventory');
    // 同じユーザーの既存 pending オファーが残っていれば拒否（最大1件）
    const existing = (trade.offers || []).find(o => o.offererId === userId && o.status === 'pending');
    if (existing) return errResp(400, 'already offered');
    const item = me.inventory[idx];
    const types = (data.settings && data.settings.gachaTypes) || [];
    const offer = {
      id: newOfferId(),
      offererId: userId,
      offererName: me.name,
      offererIcon: thinIcon(me.icon),
      offererIconType: me.iconType || 'emoji',
      item: { ...item, snapshot: snapshotPrize(item, types) },
      status: 'pending',
      createdAt: Date.now(),
    };
    trade.offers = trade.offers || [];
    trade.offers.push(offer);
    return okResp({ offerId: offer.id });
  }

  if (action === 'withdraw') {
    const trade = data.trades.find(t => t.id === body.tradeId);
    if (!trade) return errResp(404, 'trade not found');
    const offer = (trade.offers || []).find(o => o.id === body.offerId);
    if (!offer) return errResp(404, 'offer not found');
    if (offer.offererId !== userId) return errResp(403, 'not your offer');
    if (offer.status !== 'pending') return errResp(400, 'offer not pending');
    offer.status = 'withdrawn';
    offer.withdrawnAt = Date.now();
    return okResp({});
  }

  if (action === 'accept') {
    const trade = data.trades.find(t => t.id === body.tradeId);
    if (!trade) return errResp(404, 'trade not found');
    if (trade.ownerId !== userId) return errResp(403, 'not owner');
    if (trade.status !== 'open') return errResp(400, 'trade not open');
    const offer = (trade.offers || []).find(o => o.id === body.offerId);
    if (!offer) return errResp(404, 'offer not found');
    if (offer.status !== 'pending') return errResp(400, 'offer not pending');

    const owner = data.users.find(u => u.id === trade.ownerId);
    const offerer = data.users.find(u => u.id === offer.offererId);
    if (!owner || !offerer) return errResp(404, 'user missing');

    const ownerIdx = findInventoryIndex(owner, trade.ownerItem.instanceId);
    if (ownerIdx < 0) {
      // 出品者がアイテムを失っている → トレード自体を破棄
      trade.status = 'cancelled';
      trade.cancelledAt = Date.now();
      for (const o of trade.offers) {
        if (o.status === 'pending') o.status = 'rejected';
      }
      return { status: 400, body: { ok: false, error: 'owner item missing' }, save: true };
    }
    const offererIdx = findInventoryIndex(offerer, offer.item.instanceId);
    if (offererIdx < 0) {
      // オファー者がアイテムを失っている → このオファーだけ無効化
      offer.status = 'invalidated';
      return { status: 400, body: { ok: false, error: 'offerer item missing' }, save: true };
    }

    // 交換実行：インスタンスを相手の inventory へ移動
    const ownerItem = owner.inventory.splice(ownerIdx, 1)[0];
    const offererItem = offerer.inventory.splice(offererIdx, 1)[0];
    offerer.inventory.push(ownerItem);
    owner.inventory.push(offererItem);

    trade.status = 'completed';
    trade.completedAt = Date.now();
    offer.status = 'accepted';
    // 他の pending オファーは却下
    for (const o of trade.offers) {
      if (o.id !== offer.id && o.status === 'pending') {
        o.status = 'rejected';
      }
    }
    return okResp({});
  }

  return errResp(400, 'invalid action');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  try {
    const body = req.body || {};
    if (!body.action) return res.status(400).json({ ok: false, error: 'action required' });
    if (!body.userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const lockResult = await withDataLock(redis, async () => {
      const data = await redis.get(KEY);
      if (!data || !Array.isArray(data.users)) {
        return { status: 404, body: { ok: false, error: 'no data' }, save: false };
      }
      const result = await processTrade(body, data);
      if (result.save) {
        // 旧トレードに残った base64 を掃除してから保存
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
    console.error('api/trade error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
