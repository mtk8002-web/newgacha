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
      eventName: '春の出世大競争',
      eventStartDate: now.toISOString(),
      eventEndDate: end.toISOString(),
      headerImage: '',
      // ガチャは複数種類を持てる。各タイプが独立した景品プールとコスト
      gachaTypes: [
        {
          id: 'yellow',
          name: 'イエローキャンディ',
          cost: 100,
          accent: '#f3c654',
          candyIcon: '🍬',
          candyIconType: 'emoji',
          prizes: [
            { id: 'y-n-1', name: 'サンクスメッセージ', rarity: 'N',  icon: '💌', iconType: 'emoji', weight: 60, description: '配信中に名前を呼んで感謝メッセージ' },
            { id: 'y-r-1', name: 'スタンプ画像',       rarity: 'R',  icon: '🎴', iconType: 'emoji', weight: 30, description: 'ロゴ入りスタンプ風画像1枚' },
            { id: 'y-sr-1', name: 'ハート×10',         rarity: 'SR', icon: '💖', iconType: 'emoji', weight: 10, description: '愛風船バスター×10個' },
          ],
        },
        {
          id: 'pink',
          name: 'ピンクキャンディ',
          cost: 1000,
          accent: '#e8638a',
          candyIcon: '🍭',
          candyIconType: 'emoji',
          prizes: [
            { id: 'p-r-1',  name: 'ハート×1',          rarity: 'R',   icon: '💖', iconType: 'emoji', weight: 50, description: '愛風船バスター×1個' },
            { id: 'p-sr-1', name: 'SDちびイラスト',    rarity: 'SR',  icon: '🖼️', iconType: 'emoji', weight: 35, description: 'デフォルメSDイラスト1枚' },
            { id: 'p-ssr-1', name: 'バストアップ',     rarity: 'SSR', icon: '🎨', iconType: 'emoji', weight: 14, description: 'バストアップカラーイラスト' },
            { id: 'p-ur-1', name: 'ボーナス2000Spoon相当', rarity: 'UR', icon: '🪙', iconType: 'emoji', weight: 1, description: '当たる確率0.1%、2000 Spoon相当のボーナス' },
          ],
        },
        {
          id: 'blue',
          name: 'ブルーキャンディ',
          cost: 2000,
          accent: '#5fa8c8',
          candyIcon: '🧁',
          candyIconType: 'emoji',
          prizes: [
            { id: 'b-sr-1',  name: 'ハート×5',           rarity: 'SR',  icon: '💖', iconType: 'emoji', weight: 50, description: '愛風船バスター×5個' },
            { id: 'b-ssr-1', name: '全身カラー＋背景',   rarity: 'SSR', icon: '🖌️', iconType: 'emoji', weight: 30, description: '全身カラーイラスト＋背景つき' },
            { id: 'b-ssr-2', name: '描き下ろし限定',     rarity: 'SSR', icon: '👑', iconType: 'emoji', weight: 19, description: '描き下ろし限定イラスト＋直筆サイン' },
            { id: 'b-ur-1',  name: 'ボーナス10000Spoon相当', rarity: 'UR', icon: '🪙', iconType: 'emoji', weight: 1, description: '当たる確率0.1%、10000 Spoon相当のボーナス' },
          ],
        },
      ],
    },
    version: 3,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const data = await redis.get(KEY);
      return res.status(200).json(data || getDefaultData());
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
