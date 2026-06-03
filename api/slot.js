// /api/slot
// パチスロ風スロット抽選。
// body: { userId, free?: boolean }
//   free=true: 前回がリプレイ成立（slotReplayPending=true）の場合のみ無料スピン
//
// 2層抽選モデル：
//   1) 小役抽選（pt/GP の払い出し小役）
//   2) ボーナス重複抽選（小役を契機に BIG/REG。当選時は景品が当たる）
//
// 既存 /api/pull と同じ Redis 分散ロックで GET-MODIFY-SET を直列化。
// ビジー時は 503 を返してフロントが最大3回リトライする規約に乗る。
import { Redis } from '@upstash/redis';
import crypto from 'crypto';
import { withDataLock } from '../lib/lock.js';
import { ensureUserInventory, makeInstanceId, sanitizeAllTradeIcons } from '../lib/inventory.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

function availableSpoon(user) {
  return Math.max(0, (user.totalSpoon || 0) - (user.spentSpoon || 0));
}

// 暗号論的乱数 0..1
function secureRandom() {
  const buf = crypto.randomBytes(6);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + buf[i];
  return n / Math.pow(256, 6);
}

// weight 比率でランダム選択。weight<=0 は除外。
function weightedPick(arr, weightKey = 'weight') {
  const valid = (arr || []).filter(p => (Number(p[weightKey]) || 0) > 0);
  if (valid.length === 0) return null;
  const total = valid.reduce((s, p) => s + (Number(p[weightKey]) || 0), 0);
  let r = secureRandom() * total;
  for (const p of valid) {
    r -= (Number(p[weightKey]) || 0);
    if (r <= 0) return p;
  }
  return valid[valid.length - 1];
}

function pickRandSymbol(symbolIds, excludeSet) {
  const pool = symbolIds.filter(s => !excludeSet || !excludeSet.has(s));
  if (pool.length === 0) return symbolIds[0] || 'blank';
  return pool[Math.floor(secureRandom() * pool.length)];
}

// 役に応じてリール停止目を決定。
// all3=3つ揃い / left1=左1個（中右は揃わせない） / none=ハズレ出目
function decideReels(role, slot) {
  const symbols = slot.symbols || [];
  const symbolIds = symbols.map(s => s.id);
  // 告知出目（seven / mushroom）は小役のハズレ・チェリーで偶然出ないように除外候補へ
  const TELL_SYMBOLS = new Set(['seven', 'mushroom']);

  if (role.match === 'all3') {
    return [role.symbolId, role.symbolId, role.symbolId];
  }
  if (role.match === 'left1') {
    // 左にチェリー、中・右は揃わず＆告知出目も避ける
    const a = role.symbolId;
    const exclude = new Set([a, ...TELL_SYMBOLS]);
    let b, c;
    for (let tries = 0; tries < 20; tries++) {
      b = pickRandSymbol(symbolIds, exclude);
      c = pickRandSymbol(symbolIds, exclude);
      if (!(b === c)) break;
    }
    return [a, b, c];
  }
  if (role.match === 'none') {
    // ハズレ：3つ揃わず・左にチェリーが来ず・告知出目で揃わない
    const all3SymbolSet = new Set((slot.roles || []).filter(r => r.match === 'all3').map(r => r.symbolId));
    for (let tries = 0; tries < 30; tries++) {
      const a = pickRandSymbol(symbolIds, new Set(['cherry']));
      const b = pickRandSymbol(symbolIds);
      const c = pickRandSymbol(symbolIds);
      if (a === b && b === c) continue;
      // 念のため：偶然「all3 役の図柄で3つ揃い」になっていないこと
      if (a === b && b === c && all3SymbolSet.has(a)) continue;
      return [a, b, c];
    }
    return ['blank', 'bell', 'bar'];
  }
  // 想定外
  return [role.symbolId, role.symbolId, role.symbolId];
}

// ボーナス告知出目
function decideTellReels(typeId, slot) {
  const def = ((slot.bonus && slot.bonus.types) || []).find(t => t.id === typeId);
  const sid = (def && def.tellSymbolId) || (typeId === 'big' ? 'seven' : 'mushroom');
  return [sid, sid, sid];
}

// inventory.js の流儀でユーザーにスロット用フィールドを補完
function ensureSlotFields(user) {
  if (!Array.isArray(user.slotHistory)) user.slotHistory = [];
  if (!user.slotStats || typeof user.slotStats !== 'object') {
    user.slotStats = { spins: 0, totalBet: 0, totalPayout: 0, bonusBig: 0, bonusReg: 0, maxPayout: 0 };
  }
  if (typeof user.slotReplayPending !== 'boolean') user.slotReplayPending = false;
}

// 既存ガチャタイプから景品定義を解決（pity 含む）
function resolvePrize(gachaTypes, gachaTypeId, prizeId) {
  const t = (gachaTypes || []).find(x => x.id === gachaTypeId);
  if (!t) return null;
  if (prizeId === `pity-${t.id}` && t.pityPrize) {
    return {
      def: t.pityPrize,
      type: t,
      isPity: true,
      name: t.pityPrize.name,
      rarity: t.pityPrize.rarity || 'UR',
      icon: t.pityPrize.icon || '🏆',
      iconType: t.pityPrize.iconType || 'emoji',
      description: t.pityPrize.description || '',
    };
  }
  const p = (t.prizes || []).find(x => x.id === prizeId);
  if (!p) return null;
  return {
    def: p,
    type: t,
    isPity: false,
    name: p.name,
    rarity: p.rarity || 'N',
    icon: p.icon || '🎁',
    iconType: p.iconType || 'emoji',
    description: p.description || '',
  };
}

// base64 画像は履歴側には載せない（容量肥大対策。/api/pull と同じ規約）
function thinIcon(icon) {
  return (typeof icon === 'string' && icon.startsWith('data:image')) ? '' : (icon || '');
}

async function processSlot({ userId, free }) {
  const data = await redis.get(KEY);
  if (!data || !Array.isArray(data.users)) {
    return { status: 404, body: { ok: false, error: 'no data' } };
  }
  const user = data.users.find(u => u.id === userId);
  if (!user) return { status: 404, body: { ok: false, error: 'user not found' } };

  const slot = data.settings && data.settings.slot;
  if (!slot || !slot.enabled) {
    return { status: 403, body: { ok: false, error: 'slot disabled' } };
  }

  ensureUserInventory(user);
  ensureSlotFields(user);

  const bet = Math.max(0, Math.floor(Number(slot.cost) || 0));
  const isFreeSpin = !!free && !!user.slotReplayPending;

  if (!isFreeSpin) {
    if (availableSpoon(user) < bet) {
      return { status: 400, body: { ok: false, error: 'not enough pt' } };
    }
    user.spentSpoon = (user.spentSpoon || 0) + bet;
  }
  // フリースピンは消費するのでフラグをクリア。リプレイ成立すれば後段で再付与。
  user.slotReplayPending = false;

  // --- 小役抽選 ---
  const role = weightedPick(slot.roles);
  if (!role) {
    return { status: 400, body: { ok: false, error: 'no roles configured' } };
  }

  // 出目を決定
  let reels = decideReels(role, slot);

  // 小役払い出し
  const payCurrency = slot.payoutCurrency === 'pt' ? 'pt' : 'gachaPoint';
  const payout = Math.max(0, Math.floor(Number(role.payout) || 0));
  if (payout > 0) {
    if (payCurrency === 'gachaPoint') {
      user.gachaPoint = Math.max(0, Math.floor(Number(user.gachaPoint) || 0)) + payout;
    } else {
      // pt 還元：累計を汚さないように消費を戻す方式
      user.spentSpoon = Math.max(0, (user.spentSpoon || 0) - payout);
    }
  }
  if (role.replay) user.slotReplayPending = true;

  // --- ボーナス重複抽選 ---
  let bonus = null;
  const types = (data.settings.gachaTypes || []);
  if (slot.bonus && slot.bonus.enabled) {
    const rates = (slot.bonus.overlap || {})[role.id] || {};
    const rateBig = Number(rates.big) || 0;
    const rateReg = Number(rates.reg) || 0;
    const r = secureRandom();
    let hit = null;
    if (r < rateBig) hit = 'big';
    else if (r < rateBig + rateReg) hit = 'reg';

    if (hit) {
      const def = (slot.bonus.types || []).find(t => t.id === hit);
      if (def) {
        // 景品プールから実在するものだけ抽選候補に
        const pool = (def.prizePool || []).filter(pp => {
          return !!resolvePrize(types, pp.gachaTypeId, pp.prizeId);
        });
        const pick = weightedPick(pool);
        if (pick) {
          // 景品が確定してから告知出目に差し替え（プール空なら通常の出目のまま）
          reels = decideTellReels(hit, slot);
          const resolved = resolvePrize(types, pick.gachaTypeId, pick.prizeId);
          const now = Date.now();
          const instance = {
            instanceId: makeInstanceId(),
            prizeId: pick.prizeId,
            gachaTypeId: pick.gachaTypeId,
            acquiredAt: now,
            isPity: false,
            source: 'slot-bonus',
            bonusType: hit,
          };
          user.inventory = user.inventory || [];
          user.inventory.push(instance);

          // ギャラリー・アクティビティに乗るよう gachaHistory にも記録
          user.gachaHistory = user.gachaHistory || [];
          user.gachaHistory.push({
            gachaTypeId: pick.gachaTypeId,
            gachaTypeName: resolved.type.name,
            cost: 0,
            prizeId: pick.prizeId,
            prizeName: resolved.name,
            rarity: resolved.rarity,
            prizeIcon: thinIcon(resolved.icon),
            prizeIconType: resolved.iconType,
            isPity: false,
            paidWith: hit === 'big' ? 'slot-big' : 'slot-reg',
            timestamp: now,
          });

          bonus = {
            typeId: hit,
            typeName: def.name,
            color: def.color || (hit === 'big' ? '#d4ad55' : '#5fa8c8'),
            prize: {
              name: resolved.name,
              rarity: resolved.rarity,
              icon: resolved.icon,
              iconType: resolved.iconType,
              description: resolved.description,
            },
            instanceId: instance.instanceId,
          };

          if (hit === 'big') user.slotStats.bonusBig = (user.slotStats.bonusBig || 0) + 1;
          else                user.slotStats.bonusReg = (user.slotStats.bonusReg || 0) + 1;
        }
      }
    }
  }

  // 履歴
  user.slotHistory.unshift({
    timestamp: Date.now(),
    roleId: role.id,
    roleName: role.name,
    payout,
    payCurrency,
    isReplay: !!role.replay,
    reels,
    bonus: bonus ? {
      typeId: bonus.typeId,
      typeName: bonus.typeName,
      prizeName: bonus.prize.name,
      rarity: bonus.prize.rarity,
      instanceId: bonus.instanceId,
    } : null,
  });
  user.slotHistory = user.slotHistory.slice(0, 100);

  // 統計
  user.slotStats.spins      = (user.slotStats.spins || 0) + 1;
  user.slotStats.totalBet   = (user.slotStats.totalBet || 0) + (isFreeSpin ? 0 : bet);
  user.slotStats.totalPayout = (user.slotStats.totalPayout || 0) + payout;
  user.slotStats.maxPayout  = Math.max(user.slotStats.maxPayout || 0, payout);

  // 既存 /api/pull と同じく trade の base64 を都度掃除
  sanitizeAllTradeIcons(data);
  await redis.set(KEY, data);

  return {
    status: 200,
    body: {
      ok: true,
      result: {
        reels,
        role: { id: role.id, name: role.name, tier: role.tier, payout },
        bonus,
        isReplay: !!role.replay,
        freeSpinNext: !!role.replay,
        wasFreeSpin: isFreeSpin,
      },
      balances: {
        pt: availableSpoon(user),
        gachaPoint: Math.max(0, Math.floor(Number(user.gachaPoint) || 0)),
      },
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  try {
    const { userId, free } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'userId required' });

    const lockResult = await withDataLock(redis, () => processSlot({ userId, free: !!free }));
    if (lockResult.busy) {
      return res.status(503).json({ ok: false, error: 'busy, retry' });
    }
    const { status, body } = lockResult.result;
    return res.status(status).json(body);
  } catch (e) {
    console.error('api/slot error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
