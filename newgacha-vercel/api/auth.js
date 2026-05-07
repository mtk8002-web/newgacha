// /api/auth
// 管理者トークンの検証だけを行うエンドポイント
// データを書き込まずに「ログイン可否」だけ確認できる
export default function handler(req, res) {
  const auth = req.headers['authorization'] || '';
  const expected = `Bearer ${process.env.ADMIN_TOKEN || ''}`;
  if (!process.env.ADMIN_TOKEN || auth !== expected) {
    return res.status(401).json({ ok: false });
  }
  return res.status(200).json({ ok: true });
}
