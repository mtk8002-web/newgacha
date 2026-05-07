// /api/data
// GET  : 共有データを取得（誰でもOK）
// POST : 共有データを上書き（Bearer ADMIN_TOKEN 必須）
import { Redis } from '@upstash/redis';

const KEY = 'mtk_app_data';

const redis = Redis.fromEnv(); // UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN を自動使用

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
      gachaThreshold: 5000,
      gachaPrizes: [
        { id: 'p-n-1',   name: 'サンクスメッセージ',     rarity: 'N',   icon: '💌', iconType: 'emoji', weight: 50, description: '配信中に名前を呼んで感謝メッセージ' },
        { id: 'p-n-2',   name: 'スタンプ画像',           rarity: 'N',   icon: '🎴', iconType: 'emoji', weight: 35, description: 'ロゴ入りスタンプ風画像1枚' },
        { id: 'p-r-1',   name: 'SDちびイラスト',         rarity: 'R',   icon: '🖼️', iconType: 'emoji', weight: 20, description: 'デフォルメSDイラスト1枚' },
        { id: 'p-sr-1',  name: 'バストアップカラー',     rarity: 'SR',  icon: '🎨', iconType: 'emoji', weight: 8,  description: 'バストアップのカラーイラスト1枚' },
        { id: 'p-sr-2',  name: '全身カラー＋背景つき',   rarity: 'SR',  icon: '🖌️', iconType: 'emoji', weight: 4,  description: '全身カラーイラスト＋背景つき' },
        { id: 'p-ssr-1', name: '描き下ろし限定＋サイン', rarity: 'SSR', icon: '👑', iconType: 'emoji', weight: 1,  description: '描き下ろし限定イラスト＋直筆サイン' },
      ],
      headerImage: '',
    },
    version: 2,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const data = await redis.get(KEY);
      // Upstash は JSON を直接返してくれる
      return res.status(200).json(data || getDefaultData());
    }

    if (req.method === 'POST') {
      // 簡易認証: Authorization: Bearer <ADMIN_TOKEN>
      const auth = req.headers['authorization'] || '';
      const expected = `Bearer ${process.env.ADMIN_TOKEN || ''}`;
      if (!process.env.ADMIN_TOKEN || auth !== expected) {
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }

      // body は Vercel が JSON として解釈済み
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
