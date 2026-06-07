// /api/user-prefs
// ユーザー個人設定（現在は iconPrize のみ。将来拡張用に action 分岐）
//
// body:
//   { userId, action: 'setIconPrize', gachaTypeId, prizeId }
//   { userId, action: 'clearIconPrize' }
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';
import { ensureUserInventory } from '../lib/inventory.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

async function processPrefs(body, data) {
  const { userId, action } = body;
  const user = (data.users || []).find(u => u.id === userId);
  if (!user) return { status: 404, body: { ok: false, error: 'user not found' }, save: false };

  ensureUserInventory(user);

  if (action === 'setIconPrize') {
    const { gachaTypeId, prizeId } = body;
    if (!gachaTypeId || !prizeId) {
      return { status: 400, body: { ok: false, error: 'gachaTypeId/prizeId required' }, save: false };
    }
    // 所持確認
    const owns = (user.inventory || []).some(it => it.gachaTypeId === gachaTypeId && it.prizeId === prizeId);
    if (!owns) return { status: 400, body: { ok: false, error: 'not owned' }, save: false };
    user.iconPrize = { gachaTypeId, prizeId };
    user.iconImage = null; // 排他：アップロード画像アイコンは解除
    return { status: 200, body: { ok: true, iconPrize: user.iconPrize }, save: true };
  }

  if (action === 'clearIconPrize') {
    user.iconPrize = null;
    return { status: 200, body: { ok: true, iconPrize: null }, save: true };
  }

  // ユーザー自身がアップロードした画像をアイコンに設定
  if (action === 'setIconImage') {
    const { image } = body;
    if (typeof image !== 'string' || !image.startsWith('data:image')) {
      return { status: 400, body: { ok: false, error: 'invalid image' }, save: false };
    }
    // 過大画像を弾く（クライアントで256pxにリサイズ済みの想定。base64で ~700KB 上限）
    if (image.length > 700000) {
      return { status: 400, body: { ok: false, error: 'image too large' }, save: false };
    }
    user.iconImage = image;
    user.iconPrize = null; // 排他：景品アイコンは解除
    return { status: 200, body: { ok: true }, save: true };
  }

  // アイコンを既定（admin設定 or 👤）に戻す
  if (action === 'clearIcon') {
    user.iconImage = null;
    user.iconPrize = null;
    return { status: 200, body: { ok: true }, save: true };
  }

  return { status: 400, body: { ok: false, error: 'invalid action' }, save: false };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  try {
    const body = req.body || {};
    if (!body.userId) return res.status(400).json({ ok: false, error: 'userId required' });
    if (!body.action) return res.status(400).json({ ok: false, error: 'action required' });

    const lockResult = await withDataLock(redis, async () => {
      const data = await redis.get(KEY);
      if (!data || !Array.isArray(data.users)) {
        return { status: 404, body: { ok: false, error: 'no data' }, save: false };
      }
      const result = await processPrefs(body, data);
      if (result.save) {
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
    console.error('api/user-prefs error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
