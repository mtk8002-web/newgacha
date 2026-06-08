// /api/data
// GET  : 共有データを取得（誰でもOK）
// POST : 共有データを上書き（Bearer ADMIN_TOKEN 必須）
import { Redis } from '@upstash/redis';
import { withDataLock } from '../lib/lock.js';
import { ensureAllInventories, sanitizeAllTradeIcons } from '../lib/inventory.js';

const KEY = 'mtk_app_data';
const redis = Redis.fromEnv();

// 初期データ（DBが空の最初のアクセスで返す）
function getDefaultData() {
  const now = new Date();
  const end = new Date(Date.now() + 14 * 86400000);
  return {
    users: [],
    settings: {
      // サイト基本情報
      siteName: 'GACHA',
      logoText: 'GACHA',
      footerText: '© GACHA',
      // イベント
      eventName: 'イベント',
      eventNameEn: 'Event',
      eventStartDate: now.toISOString(),
      eventEndDate: end.toISOString(),
      headerImage: '',
      // シーズン（ランキングのリセット単位）
      season: { number: 1, name: 'シーズン1', startedAt: now.toISOString() },
      seasonArchive: [],
      // セクションタイトル（公開ページ）
      rankingTitle: 'ランキング',
      rankingTitleEn: 'Top Players',
      gachaTitle: 'ガチャ',
      gachaTitleEn: 'Lucky Draw',
      feedTitle: 'アクティビティ',
      feedTitleEn: 'Activity Feed',
      prizeTitle: '景品一覧',
      prizeTitleEn: 'Prize Catalog',
      // 表記
      userLabel: 'ユーザー',
      // 分解（salvage）レアリティ別ガチャpt獲得レート
      salvageRates: { N: 10, R: 25, SR: 50, SSR: 100, UR: 500 },
      // 限界突破の最大段階（0..max の合計 max+1 段階）
      limitBreakMax: 4,
      // スロット機能の設定（運営が管理画面で編集可能）
      slot: {
        enabled: true,
        cost: 100,            // 1スピンの消費pt
        payoutCurrency: 'pt',
        // フリーズ（プレミアム）：低確率で発生 → 暗転＋豪華演出 → フリーズ専用景品
        freeze: { enabled: true, prob: 0.1, prizes: [
          { id: 'fz-1', name: 'でかきのこ', icon: '', iconType: 'image', mushroom: 100, weight: 1 },
        ] },
        // 図柄は意味のある6種（api/slot.js と同期）
        symbols: [
          { id: 'seven', icon: '7️⃣' }, { id: 'watermelon', icon: '🍉' }, { id: 'cherry', icon: '🍒' },
          { id: 'bell', icon: '🔔' }, { id: 'replay', icon: '🔄' }, { id: 'mushroom', icon: '🍄' },
        ],
        // 役は確率(%)。はずれは 100 - その他合計 で自動算出
        roles: [
          { id: 'replay',     name: 'リプレイ', match: 'all3',  symbolId: 'replay',     prob: 8,    payout: 0,   currency: 'pt', replay: true, tier: 'replay' },
          { id: 'watermelon', name: 'スイカ',   match: 'all3',  symbolId: 'watermelon', prob: 4,    payout: 100, currency: 'pt', tier: 'small' },
          { id: 'cherry',     name: 'チェリー', match: 'left1', symbolId: 'cherry',     prob: 10,   payout: 30,  currency: 'pt', tier: 'small' },
          { id: 'bell',       name: 'ベル',     match: 'all3',  symbolId: 'bell',       prob: 12,   payout: 20,  currency: 'pt', tier: 'small' },
          { id: 'big',        name: '単独BIG',  match: 'none',  prob: 0.4,  tier: 'big', bonus: 'big' },
          { id: 'reg',        name: '単独REG',  match: 'none',  prob: 0.8,  tier: 'reg', bonus: 'reg' },
          { id: 'lose',       name: 'はずれ',   match: 'none',  prob: 0,    tier: 'lose' },
        ],
        // スイカ/チェリーからの重複当選確率(%)
        overlap: {
          watermelon: { big: 30, reg: 10 },
          cherry:     { big: 5,  reg: 20 },
        },
        // BIG/REG はスロット専用景品（画像・きのこpt）を払い出す
        bonus: {
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
        },
      },
      // ガチャは複数種類を持てる。各タイプが独立した景品プールとコスト
      gachaTypes: [
        {
          id: 'yellow',
          name: 'イエローキャンディ',
          cost: 100,
          multiPullCount: 10,
          pityCount: 0,
          pityPrize: null,
          hidden: false,
          accent: '#f3c654',
          candyIcon: '🍬',
          candyIconType: 'emoji',
          prizes: [
            { id: 'y-n-1', name: 'サンクスメッセージ', rarity: 'N',  icon: '💌', iconType: 'emoji', weight: 60, description: '管理者から感謝メッセージ' },
            { id: 'y-r-1', name: 'スタンプ画像',       rarity: 'R',  icon: '🎴', iconType: 'emoji', weight: 30, description: 'ロゴ入りスタンプ風画像1枚' },
            { id: 'y-sr-1', name: 'ハート×10',         rarity: 'SR', icon: '💖', iconType: 'emoji', weight: 10, description: 'プレミアム景品×10個' },
          ],
        },
        {
          id: 'pink',
          name: 'ピンクキャンディ',
          cost: 1000,
          multiPullCount: 10,
          pityCount: 0,
          pityPrize: null,
          hidden: false,
          accent: '#e8638a',
          candyIcon: '🍭',
          candyIconType: 'emoji',
          prizes: [
            { id: 'p-r-1',  name: 'ハート×1',          rarity: 'R',   icon: '💖', iconType: 'emoji', weight: 50, description: 'プレミアム景品×1個' },
            { id: 'p-sr-1', name: 'SDちびイラスト',    rarity: 'SR',  icon: '🖼️', iconType: 'emoji', weight: 35, description: 'デフォルメSDイラスト1枚' },
            { id: 'p-ssr-1', name: 'バストアップ',     rarity: 'SSR', icon: '🎨', iconType: 'emoji', weight: 14, description: 'バストアップカラーイラスト' },
            { id: 'p-ur-1', name: 'ボーナス2000pt相当', rarity: 'UR', icon: '🪙', iconType: 'emoji', weight: 1, description: '当たる確率0.1%、2000 pt相当のボーナス' },
          ],
        },
        {
          id: 'blue',
          name: 'ブルーキャンディ',
          cost: 2000,
          multiPullCount: 10,
          pityCount: 0,
          pityPrize: null,
          hidden: false,
          accent: '#5fa8c8',
          candyIcon: '🧁',
          candyIconType: 'emoji',
          prizes: [
            { id: 'b-sr-1',  name: 'ハート×5',           rarity: 'SR',  icon: '💖', iconType: 'emoji', weight: 50, description: 'プレミアム景品×5個' },
            { id: 'b-ssr-1', name: '全身カラー＋背景',   rarity: 'SSR', icon: '🖌️', iconType: 'emoji', weight: 30, description: '全身カラーイラスト＋背景つき' },
            { id: 'b-ssr-2', name: '描き下ろし限定',     rarity: 'SSR', icon: '👑', iconType: 'emoji', weight: 19, description: '描き下ろし限定イラスト＋直筆サイン' },
            { id: 'b-ur-1',  name: 'ボーナス10000pt相当', rarity: 'UR', icon: '🪙', iconType: 'emoji', weight: 1, description: '当たる確率0.1%、10000 pt相当のボーナス' },
          ],
        },
      ],
    },
    version: 4,
  };
}

// クライアントへ返すデータからパスワードハッシュを除外し、
// 設定済みかどうかだけ hasPassword フラグで公開する
function sanitizeForClient(data) {
  if (!data || !Array.isArray(data.users)) return data;
  // 旧データで inventory が未初期化のユーザー向けに、決定的 instanceId で在庫を構築
  ensureAllInventories(data);
  if (!Array.isArray(data.trades)) data.trades = [];
  return {
    ...data,
    users: data.users.map(u => {
      const { passwordHash, passwordSalt, ...rest } = u;
      return { ...rest, hasPassword: !!passwordHash };
    }),
  };
}

// 容量肥大対策：保存前に全ユーザーの gachaHistory から base64 画像を削除する。
// 表示時は prizeId/gachaTypeId から gachaTypes に問い合わせれば最新のアイコンが取れるので、
// 履歴側に画像本体を持たせる必要はない。
function sanitizeAllGachaHistory(data) {
  if (!data || !Array.isArray(data.users)) return;
  for (const u of data.users) {
    if (!Array.isArray(u.gachaHistory)) continue;
    for (const h of u.gachaHistory) {
      if (typeof h.prizeIcon === 'string' && h.prizeIcon.startsWith('data:image')) {
        h.prizeIcon = '';
      }
    }
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const data = await redis.get(KEY);
      return res.status(200).json(sanitizeForClient(data || getDefaultData()));
    }

    if (req.method === 'POST') {
      const auth = req.headers['authorization'] || '';
      const expected = `Bearer ${process.env.ADMIN_TOKEN || ''}`;
      if (!process.env.ADMIN_TOKEN || auth !== expected) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      const body = req.body;
      if (!body || typeof body !== 'object' || !body.settings) {
        return res.status(400).json({ ok: false, error: 'invalid body' });
      }
      // 分散ロックで GET-MERGE-SET を直列化（pull/auth と同時実行された場合の上書き競合を防止）
      const lockResult = await withDataLock(redis, async () => {
        // クライアントが触らない/触るべきでないフィールドは既存値で上書きから守る：
        //  - passwordHash / passwordSalt（GETで返さないので body には含まれない）
        //  - pityCounts（pull が真実の源。adminの古いキャッシュで巻き戻さないため）
        //  - spentSpoon / gachaHistory（pull が真実の源。adminは加算/削除しないので保護）
        const existing = await redis.get(KEY);
        if (existing && Array.isArray(existing.users) && Array.isArray(body.users)) {
          for (const u of body.users) {
            const old = existing.users.find(x => x.id === u.id);
            if (old) {
              if (old.passwordHash) {
                u.passwordHash = old.passwordHash;
                u.passwordSalt = old.passwordSalt;
              }
              if (old.pityCounts && typeof old.pityCounts === 'object') {
                u.pityCounts = old.pityCounts;
              }
              if (typeof old.spentSpoon === 'number') {
                u.spentSpoon = old.spentSpoon;
              }
              if (Array.isArray(old.gachaHistory)) {
                u.gachaHistory = old.gachaHistory;
              }
              // inventory も pull/trade が真実の源。admin の編集で巻き戻さない。
              if (Array.isArray(old.inventory)) {
                u.inventory = old.inventory;
              }
              // gachaPoint / limitBreaks / iconPrize も pull/salvage/limit-break/user-prefs が真実の源
              if (typeof old.gachaPoint === 'number') {
                u.gachaPoint = old.gachaPoint;
              }
              if (old.limitBreaks && typeof old.limitBreaks === 'object') {
                u.limitBreaks = old.limitBreaks;
              }
              if (old.iconPrize !== undefined) {
                u.iconPrize = old.iconPrize;
              }
              // ユーザー自身がアップロードしたアイコン画像も user-prefs が真実の源
              if (old.iconImage !== undefined) {
                u.iconImage = old.iconImage;
              }
              // 分解履歴も salvage が真実の源（adminで巻き戻さない）
              if (Array.isArray(old.salvageHistory)) {
                u.salvageHistory = old.salvageHistory;
              }
              // slot 機能のユーザー状態も /api/slot が真実の源。admin で巻き戻さない。
              if (Array.isArray(old.slotHistory)) {
                u.slotHistory = old.slotHistory;
              }
              if (old.slotStats && typeof old.slotStats === 'object') {
                u.slotStats = old.slotStats;
              }
              if (typeof old.slotReplayPending === 'boolean') {
                u.slotReplayPending = old.slotReplayPending;
              }
              if (old.slotBonusPending !== undefined) {
                u.slotBonusPending = old.slotBonusPending;
              }
              // スロット専用ランキング：きのこpt / 専用景品コレクションも /api/slot が真実の源
              if (typeof old.mushroomPt === 'number') {
                u.mushroomPt = old.mushroomPt;
              }
              if (Array.isArray(old.slotPrizes)) {
                u.slotPrizes = old.slotPrizes;
              }
            }
            delete u.hasPassword;
          }
        } else if (Array.isArray(body.users)) {
          for (const u of body.users) delete u.hasPassword;
        }
        // 履歴の base64 画像を保存前に削除（10MB制限対策）
        sanitizeAllGachaHistory(body);
        // admin が trades を書き戻すことはないので、サーバー側 trades を保護。
        // ただし「全データリセット」（users=[]）の場合は trades も一緒に消す（stale参照の防止）。
        const isFullReset = Array.isArray(body.users) && body.users.length === 0
          && existing && Array.isArray(existing.users) && existing.users.length > 0;
        if (isFullReset) {
          body.trades = [];
        } else if (existing && Array.isArray(existing.trades)) {
          body.trades = existing.trades;
        } else if (!Array.isArray(body.trades)) {
          body.trades = [];
        }
        // 旧データに base64 アイコンが残っていれば掃除
        sanitizeAllTradeIcons(body);
        await redis.set(KEY, body);
      });
      if (lockResult.busy) {
        return res.status(503).json({ ok: false, error: 'busy, retry' });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('api/data error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
