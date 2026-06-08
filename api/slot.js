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
  // pt は一本化。旧「ガチャpt(gachaPoint)」も使える pt に合算する。
  const g = Math.max(0, Math.floor(Number(user.gachaPoint) || 0));
  return Math.max(0, (user.totalSpoon || 0) - (user.spentSpoon || 0) + g);
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
  if (pool.length === 0) return symbolIds[0] || 'bell';
  return pool[Math.floor(secureRandom() * pool.length)];
}

// ============================================================
// スロット既定値（管理画面 未設定でも動くようフォールバック）
// ============================================================
const DEFAULT_SLOT_SYMBOLS = [
  { id: 'seven', icon: '7️⃣' }, { id: 'watermelon', icon: '🍉' }, { id: 'cherry', icon: '🍒' },
  { id: 'bell', icon: '🔔' }, { id: 'replay', icon: '🔄' }, { id: 'mushroom', icon: '🍄' },
];
// 役は固定（リプレイ / スイカ / チェリー / ベル / 単独BIG / 単独REG / はずれ）。
// prob は確率(%)。はずれは 100 - その他合計 で自動算出。
const DEFAULT_SLOT_ROLES = [
  { id: 'replay',     name: 'リプレイ', match: 'all3',  symbolId: 'replay',     prob: 8,    payout: 0,   currency: 'pt', replay: true, tier: 'replay' },
  { id: 'watermelon', name: 'スイカ',   match: 'all3',  symbolId: 'watermelon', prob: 4,    payout: 100, currency: 'pt', tier: 'small' },
  { id: 'cherry',     name: 'チェリー', match: 'left1', symbolId: 'cherry',     prob: 10,   payout: 30,  currency: 'pt', tier: 'small' },
  { id: 'bell',       name: 'ベル',     match: 'all3',  symbolId: 'bell',       prob: 12,   payout: 20,  currency: 'pt', tier: 'small' },
  { id: 'big',        name: '単独BIG',  match: 'none',  prob: 0.4,  tier: 'big', bonus: 'big' },
  { id: 'reg',        name: '単独REG',  match: 'none',  prob: 0.8,  tier: 'reg', bonus: 'reg' },
  { id: 'lose',       name: 'はずれ',   match: 'none',  prob: 0,    tier: 'lose' },
];
// スイカ / チェリーからの重複当選確率(%)
const DEFAULT_SLOT_OVERLAP = {
  watermelon: { big: 30, reg: 10 },
  cherry:     { big: 5,  reg: 20 },
};
// BIG/REG はスロット専用景品（管理者が画像・きのこpt・重みを設定）を払い出す。
const DEFAULT_SLOT_BONUS = {
  enabled: true,
  types: [
    { id: 'big', name: 'BIG BONUS', tellSymbolId: 'seven', color: '#d4ad55', prizes: [
      { id: 'big-1', name: 'おおきのこ', icon: '', iconType: 'image', mushroom: 10, weight: 50 },
      { id: 'big-2', name: 'まんねんきのこ', icon: '', iconType: 'image', mushroom: 30, weight: 10 },
    ] },
    { id: 'reg', name: 'REG BONUS', tellSymbolId: 'mushroom', color: '#5fa8c8', prizes: [
      { id: 'reg-1', name: 'こきのこ', icon: '', iconType: 'image', mushroom: 3, weight: 60 },
      { id: 'reg-2', name: 'なかきのこ', icon: '', iconType: 'image', mushroom: 8, weight: 20 },
    ] },
  ],
};

// フリーズ（プレミアム）既定：低確率で発生し、BIG景品＋豪華演出
const DEFAULT_SLOT_FREEZE = { enabled: true, prob: 0.1 };

// slot 設定を既定値で補完して返す
function getSlotConfig(slot) {
  const roles   = (Array.isArray(slot.roles)   && slot.roles.length)   ? slot.roles   : DEFAULT_SLOT_ROLES;
  const symbols = DEFAULT_SLOT_SYMBOLS; // 図柄は固定（意味のある6種のみ）
  const overlap = (slot.overlap && typeof slot.overlap === 'object')   ? slot.overlap : DEFAULT_SLOT_OVERLAP;
  const bonus   = (slot.bonus && Array.isArray(slot.bonus.types) && slot.bonus.types.length)
    ? slot.bonus : DEFAULT_SLOT_BONUS;
  const freeze  = (slot.freeze && typeof slot.freeze === 'object') ? slot.freeze : DEFAULT_SLOT_FREEZE;
  return { roles, symbols, overlap, bonus, freeze };
}

// 確率(%)で役を1つ選ぶ。はずれは「100 - その他合計」を自動付与。
function pickRoleByProb(roles) {
  const others = roles.filter(r => r.id !== 'lose');
  const sumOthers = others.reduce((s, r) => s + Math.max(0, Number(r.prob) || 0), 0);
  const loseRole = roles.find(r => r.id === 'lose')
    || { id: 'lose', name: 'はずれ', match: 'none', tier: 'lose' };
  const loseProb = Math.max(0, 100 - sumOthers);
  const pool = others.map(r => ({ r, w: Math.max(0, Number(r.prob) || 0) }));
  pool.push({ r: loseRole, w: loseProb });
  const total = pool.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return loseRole;
  let rnd = secureRandom() * total;
  for (const x of pool) { rnd -= x.w; if (rnd <= 0) return x.r; }
  return loseRole;
}

// gachaPoint を安全に整数化
function gp(user) {
  return Math.max(0, Math.floor(Number(user.gachaPoint) || 0));
}

// ボーナス景品を払い出す（スロット専用景品プールから抽選 → きのこpt 加算＋コレクション追加）
function awardBonusPrize(cfg, type, user) {
  const def = (cfg.bonus.types || []).find(t => t.id === type)
    || { id: type, name: type === 'big' ? 'BIG BONUS' : 'REG BONUS' };
  // 旧データ（prizes 未設定）でも動くよう、空なら既定のスロット専用景品にフォールバック
  const prizes = (Array.isArray(def.prizes) && def.prizes.length)
    ? def.prizes
    : ((DEFAULT_SLOT_BONUS.types.find(t => t.id === type) || {}).prizes || []);
  const pick = weightedPick(prizes); // weight キーで抽選
  const now = Date.now();
  // 景品未設定でも演出は出す（きのこpt 0 のプレースホルダ・画像なし）
  const prize = pick || { id: 'none', name: def.name || 'ボーナス', icon: '', iconType: 'image', mushroom: 0 };
  const mushroom = Math.max(0, Math.floor(Number(prize.mushroom) || 0));

  // きのこpt を加算（スロット専用ランキングのスコア）
  user.mushroomPt = Math.max(0, Math.floor(Number(user.mushroomPt) || 0)) + mushroom;

  // スロット専用コレクションに追加（アイコンは settings から解決するので id 参照で保持）
  user.slotPrizes = Array.isArray(user.slotPrizes) ? user.slotPrizes : [];
  const instanceId = makeInstanceId();
  user.slotPrizes.push({
    instanceId, bonusType: type, prizeId: prize.id,
    name: prize.name, mushroom, timestamp: now,
  });

  return {
    typeId: type, typeName: def.name,
    color: def.color || (type === 'big' ? '#d4ad55' : '#5fa8c8'),
    prize: {
      name: prize.name,
      icon: prize.icon, iconType: prize.iconType || 'emoji',
      mushroom, rarity: type === 'big' ? 'BIG' : 'REG', description: '',
    },
    instanceId, mushroom,
  };
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
    // フォールバックは「揃わず・左チェリーでない」ハズレ出目にする
    return ['bell', 'watermelon', 'mushroom'];
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
  // ボーナス間の回転数（現在のハマり / 前回 / 最大）
  const st = user.slotStats;
  if (typeof st.gamesSinceBonus !== 'number') st.gamesSinceBonus = 0;
  if (typeof st.lastBonusGames !== 'number') st.lastBonusGames = 0;
  if (typeof st.maxGamesSinceBonus !== 'number') st.maxGamesSinceBonus = 0;
  if (typeof user.slotReplayPending !== 'boolean') user.slotReplayPending = false;
  // 予約済みボーナス（ランプ点灯中）: null | 'big' | 'reg'
  if (user.slotBonusPending !== 'big' && user.slotBonusPending !== 'reg') user.slotBonusPending = null;
  // スロット専用ランキング用：きのこpt と 専用景品コレクション
  if (typeof user.mushroomPt !== 'number' || user.mushroomPt < 0) user.mushroomPt = Math.max(0, Math.floor(Number(user.mushroomPt) || 0));
  if (!Array.isArray(user.slotPrizes)) user.slotPrizes = [];
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

  const cfg = getSlotConfig(slot);
  const slotFull = { ...slot, symbols: cfg.symbols, roles: cfg.roles, overlap: cfg.overlap, bonus: cfg.bonus };
  const gachaTypes = (data.settings.gachaTypes || []);
  const bet = Math.max(0, Math.floor(Number(slot.cost) || 0));

  // 予約済みボーナス（前回ランプ点灯）があれば、このスピンは無料の「ボーナス確定演出」になる
  const pendingBonus = (user.slotBonusPending === 'big' || user.slotBonusPending === 'reg')
    ? user.slotBonusPending : null;
  // リプレイ成立は「サーバーのフラグ」を真実とする（クライアントの free 任せだと、
  // 古いキャッシュで free=false が来たとき無料スピンを取りこぼして課金してしまうため）。
  const isReplayFree = !!user.slotReplayPending && !pendingBonus;
  const isFreeSpin = !!pendingBonus || isReplayFree;

  if (!isFreeSpin) {
    if (availableSpoon(user) < bet) {
      return { status: 400, body: { ok: false, error: 'not enough pt' } };
    }
    user.spentSpoon = (user.spentSpoon || 0) + bet;
  }

  // ============================================================
  // (A) ボーナス確定演出スピン（無料・役抽選なし）
  // ============================================================
  if (pendingBonus) {
    user.slotBonusPending = null;
    const reels = decideTellReels(pendingBonus, slotFull);
    const bonus = awardBonusPrize(cfg, pendingBonus, user);

    user.slotHistory.unshift({
      timestamp: Date.now(),
      roleId: 'bonus-' + pendingBonus,
      roleName: bonus ? bonus.typeName : (pendingBonus === 'big' ? 'BIG' : 'REG'),
      payout: 0,
      payCurrency: 'pt',
      isReplay: false,
      reels,
      bonus: bonus ? {
        typeId: bonus.typeId, typeName: bonus.typeName,
        prizeName: bonus.prize.name, mushroom: bonus.mushroom, instanceId: bonus.instanceId,
      } : null,
    });
    user.slotHistory = user.slotHistory.slice(0, 100);
    user.slotStats.spins = (user.slotStats.spins || 0) + 1;
    // この演出スピンも1ゲーム。ボーナス成立なので「ボーナス間の回転数」を確定して0にリセット。
    const gsb = (Number(user.slotStats.gamesSinceBonus) || 0) + 1;
    user.slotStats.lastBonusGames = gsb;
    user.slotStats.maxGamesSinceBonus = Math.max(Number(user.slotStats.maxGamesSinceBonus) || 0, gsb);
    user.slotStats.gamesSinceBonus = 0;
    if (pendingBonus === 'big') user.slotStats.bonusBig = (user.slotStats.bonusBig || 0) + 1;
    else                        user.slotStats.bonusReg = (user.slotStats.bonusReg || 0) + 1;

    sanitizeAllTradeIcons(data);
    await redis.set(KEY, data);
    return {
      status: 200,
      body: {
        ok: true,
        result: {
          reels,
          role: { id: 'bonus', name: bonus ? bonus.typeName : pendingBonus.toUpperCase(), tier: pendingBonus, payout: 0 },
          bonus,
          bonusReserved: null,
          isReplay: false,
          wasReveal: true,
          wasFreeSpin: true,
          freeSpinNext: false,
        },
        balances: { pt: availableSpoon(user), mushroomPt: user.mushroomPt || 0 },
      },
    };
  }

  // ============================================================
  // (B-0) フリーズ抽選（プレミアム・最優先）
  //   レア抽選で発生 → リール暗転＋豪華演出 → その場で BIG 景品を獲得
  // ============================================================
  if (cfg.freeze && cfg.freeze.enabled !== false) {
    const fp = Math.max(0, Number(cfg.freeze.prob) || 0);
    if (fp > 0 && secureRandom() * 100 < fp) {
      user.slotReplayPending = false;
      const reels = decideTellReels('big', slotFull);
      const bonus = awardBonusPrize(cfg, 'big', user); // フリーズは BIG 景品
      // 統計：1ゲーム消化・ボーナス成立扱い
      user.slotStats.spins = (user.slotStats.spins || 0) + 1;
      const gsb = (Number(user.slotStats.gamesSinceBonus) || 0) + 1;
      user.slotStats.lastBonusGames = gsb;
      user.slotStats.maxGamesSinceBonus = Math.max(Number(user.slotStats.maxGamesSinceBonus) || 0, gsb);
      user.slotStats.gamesSinceBonus = 0;
      user.slotStats.bonusBig = (user.slotStats.bonusBig || 0) + 1;
      user.slotStats.totalBet = (user.slotStats.totalBet || 0) + (isFreeSpin ? 0 : bet);
      user.slotHistory.unshift({
        timestamp: Date.now(),
        roleId: 'freeze', roleName: '❄ FREEZE',
        payout: 0, payCurrency: 'pt', isReplay: false, reels,
        bonus: bonus ? { typeId: 'big', typeName: 'FREEZE', prizeName: bonus.prize.name, mushroom: bonus.mushroom, instanceId: bonus.instanceId } : null,
        freeze: true,
      });
      user.slotHistory = user.slotHistory.slice(0, 100);
      sanitizeAllTradeIcons(data);
      await redis.set(KEY, data);
      return {
        status: 200,
        body: {
          ok: true,
          result: {
            reels,
            role: { id: 'freeze', name: 'FREEZE', tier: 'big', payout: 0 },
            bonus,
            freeze: true,
            bonusReserved: null,
            isReplay: false,
            freeSpinNext: false,
            wasFreeSpin: isFreeSpin,
          },
          balances: { pt: availableSpoon(user), mushroomPt: user.mushroomPt || 0 },
        },
      };
    }
  }

  // ============================================================
  // (B) 通常スピン：役抽選（確率% / はずれ自動）
  // ============================================================
  // フリースピンは消費するのでフラグをクリア。リプレイ成立すれば後段で再付与。
  user.slotReplayPending = false;
  const role = pickRoleByProb(cfg.roles);

  const reels = decideReels(role, slotFull);

  // 小役払い出し（pt に統一：消費した pt を払い戻す方式）
  const roleCurrency = 'pt';
  const payout = Math.max(0, Math.floor(Number(role.payout) || 0));
  if (payout > 0) {
    user.spentSpoon = Math.max(0, (user.spentSpoon || 0) - payout);
  }
  if (role.replay) user.slotReplayPending = true;

  // --- ボーナス予約（単独 or スイカ/チェリー重複） ---
  let reserved = null;
  if (cfg.bonus && cfg.bonus.enabled) {
    if (role.bonus === 'big' || role.tier === 'big') reserved = 'big';
    else if (role.bonus === 'reg' || role.tier === 'reg') reserved = 'reg';
    else if (role.id === 'watermelon' || role.id === 'cherry') {
      const ov = (cfg.overlap || {})[role.id] || {};
      const pBig = Math.max(0, Number(ov.big) || 0);
      const pReg = Math.max(0, Number(ov.reg) || 0);
      const r = secureRandom() * 100;
      if (r < pBig) reserved = 'big';
      else if (r < pBig + pReg) reserved = 'reg';
    }
  }
  if (reserved) {
    // ランプ点灯 → 次の無料スピンで確定
    user.slotBonusPending = reserved;
  }

  // 履歴
  user.slotHistory.unshift({
    timestamp: Date.now(),
    roleId: role.id,
    roleName: role.name,
    payout,
    payCurrency: roleCurrency,
    isReplay: !!role.replay,
    reels,
    bonus: null,
    reserved: reserved || null,
  });
  user.slotHistory = user.slotHistory.slice(0, 100);

  // 統計
  user.slotStats.spins       = (user.slotStats.spins || 0) + 1;
  // 通常スピンはボーナス間の回転数を加算（ボーナス確定演出スピンで0にリセットされる）
  user.slotStats.gamesSinceBonus = (Number(user.slotStats.gamesSinceBonus) || 0) + 1;
  user.slotStats.maxGamesSinceBonus = Math.max(Number(user.slotStats.maxGamesSinceBonus) || 0, user.slotStats.gamesSinceBonus);
  user.slotStats.totalBet    = (user.slotStats.totalBet || 0) + (isFreeSpin ? 0 : bet);
  user.slotStats.totalPayout = (user.slotStats.totalPayout || 0) + payout;
  user.slotStats.maxPayout   = Math.max(user.slotStats.maxPayout || 0, payout);

  // 既存 /api/pull と同じく trade の base64 を都度掃除
  sanitizeAllTradeIcons(data);
  await redis.set(KEY, data);

  return {
    status: 200,
    body: {
      ok: true,
      result: {
        reels,
        role: { id: role.id, name: role.name, tier: role.tier, payout, currency: roleCurrency },
        bonus: null,
        bonusReserved: reserved,
        isReplay: !!role.replay,
        freeSpinNext: !!role.replay || !!reserved,
        wasFreeSpin: isFreeSpin,
      },
      balances: {
        pt: availableSpoon(user),
        mushroomPt: user.mushroomPt || 0,
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
