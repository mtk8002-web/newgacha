// /api/data
// GET  : 共有データを取得（誰でもOK）
// POST : 共有データを上書き（Bearer ADMIN_TOKEN 必須）
import { Redis } from '@upstash/redis';

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
      // ガチャは複数種類を持てる。各タイプが独立した景品プールとコスト
      gachaTypes: [
        {
          id: 'yellow',
          name: 'イエローキャンディ',
          cost: 100,
          multiPullCount: 10,
          pityCount: 0,
          pityPrize: null,
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
  return {
    ...data,
    users: data.users.map(u => {
      const { passwordHash, passwordSalt, ...rest } = u;
      return { ...rest, hasPassword: !!passwordHash };
    }),
  };
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
      // クライアントが触らない/触るべきでないフィールドは既存値で上書きから守る：
      //  - passwordHash / passwordSalt（GETで返さないので body には含まれない）
      //  - pityCounts（pull が真実の源。adminの古いキャッシュで巻き戻さないため）
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
          }
          delete u.hasPassword;
        }
      } else if (Array.isArray(body.users)) {
        for (const u of body.users) delete u.hasPassword;
      }
      await redis.set(KEY, body);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (e) {
    console.error('api/data error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'internal error' });
  }
}
