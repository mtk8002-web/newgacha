// /api/season
// シーズン管理（管理者のみ / Bearer ADMIN_TOKEN）。
//   POST { action: 'reset', name? }
//     現在のランキング（totalSpoon 順）をアーカイブに保存してから新シーズンを開始。
//     各ユーザーの pt（totalSpoon / spentSpoon）を 0 にリセット。
//     景品(inventory) / ガチャpt(gachaPoint) / 名前 / その他は残す。
//
// pt のリセットは /api/data POST では保護されていて出来ないため、専用エンドポイントで
// 分散ロック下に直接 GET-MODIFY-SET する。
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

const ARCHIVE_MAX = 30;     // 保存する過去シーズン数
const STANDINGS_MAX = 50;   // 1シーズンに保存する順位数

// ユーザーアイコンを「絵文字1文字」に解決（アーカイブ肥大を防ぐため base64 画像は使わない）
function resolveIconEmoji(user, gachaTypes) {
  try {
    if (user && user.iconPrize && user.iconPrize.gachaTypeId && user.iconPrize.prizeId) {
      const t = (gachaTypes || []).find(x => x.id === user.iconPrize.gachaTypeId);
      if (t) {
        let icon = null;
        if (user.iconPrize.prizeId === `pity-${t.id}` && t.pityPrize) icon = t.pityPrize.icon || '🏆';
        else {
          const p = (t.prizes || []).find(x => x.id === user.iconPrize.prizeId);
          if (p) icon = p.icon || '🎁';
        }
        if (icon && typeof icon === 'string' && !icon.startsWith('data:image')) return icon;
        if (icon) return '🏆';
      }
    }
  } catch { /* ignore */ }
  if (user && user.iconType === 'image') return '👤';
  if (user && typeof user.icon === 'string' && user.icon && !user.icon.startsWith('data:image')) return user.icon;
  return '👤';
}

function buildStandings(users, gachaTypes) {
  return (users || [])
    .slice()
    .sort((a, b) => (b.totalSpoon || 0) - (a.totalSpoon || 0))
    .filter(u => (u.totalSpoon || 0) > 0)
    .slice(0, STANDINGS_MAX)
    .map((u, i) => ({
      rank: i + 1,
      name: u.name || '',
      score: Math.max(0, Math.floor(Number(u.totalSpoon) || 0)),
      icon: resolveIconEmoji(u, gachaTypes),
    }));
}

async function processReset(name) {
  const data = await redis.get(KEY);
  if (!data || !Array.isArray(data.users)) {
    return { status: 404, body: { ok: false, error: 'no data' } };
  }
  if (!data.settings || typeof data.settings !== 'object') data.settings = {};

  const nowIso = new Date().toISOString();
  const cur = (data.settings.season && typeof data.settings.season === 'object')
    ? data.settings.season
    : { number: 1, name: 'シーズン1', startedAt: nowIso };

  // 現シーズンの順位をアーカイブ
  if (!Array.isArray(data.settings.seasonArchive)) data.settings.seasonArchive = [];
  const standings = buildStandings(data.users, (data.settings.gachaTypes || []));
  data.settings.seasonArchive.unshift({
    number: cur.number || 1,
    name: cur.name || `シーズン${cur.number || 1}`,
    startedAt: cur.startedAt || nowIso,
    endedAt: nowIso,
    standings,
  });
  // 上限を超えた古いシーズンは破棄
  data.settings.seasonArchive = data.settings.seasonArchive.slice(0, ARCHIVE_MAX);

  // 新シーズン
  const nextNumber = (Number(cur.number) || 1) + 1;
  const newName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 40) : `シーズン${nextNumber}`;
  data.settings.season = { number: nextNumber, name: newName, startedAt: nowIso };

  // 各ユーザーの pt をリセット（景品・ガチャpt・名前・その他は維持）
  for (const u of data.users) {
    u.totalSpoon = 0;
    u.spentSpoon = 0;
  }

  await redis.set(KEY, data);
  return {
    status: 200,
    body: { ok: true, season: data.settings.season, archivedCount: data.settings.seasonArchive.length },
  };
}

// 現シーズン名の変更（pt は触らない。任意・あると便利）
async function processRename(name) {
  const data = await redis.get(KEY);
  if (!data || !data.settings) return { status: 404, body: { ok: false, error: 'no data' } };
  const nowIso = new Date().toISOString();
  const cur = (data.settings.season && typeof data.settings.season === 'object')
    ? data.settings.season
    : { number: 1, name: 'シーズン1', startedAt: nowIso };
  cur.name = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 40) : cur.name;
  data.settings.season = cur;
  await redis.set(KEY, data);
  return { status: 200, body: { ok: true, season: cur } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${process.env.ADMIN_TOKEN || ''}`;
  if (!process.env.ADMIN_TOKEN || auth !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    const { action, name } = req.body || {};
    const fn = action === 'rename'
      ? () => processRename(name)
      : () => processReset(name);
    const lockResult = await withDataLock(redis, fn);
    if (lockResult.busy) return res.status(503).json({ ok: false, error: 'busy, retry' });
    const { status, body } = lockResult.result;
    return res.status(status).json(body);
  } catch (e) {
    console.error('api/season error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
