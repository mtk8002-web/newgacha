// Redis 分散ロック：複数の Serverless Function 実行を直列化する。
// SET NX EX で原子的にロック取得 → 成功時は処理 → finally で解放。
// ロック取得に失敗（取れなかった）した場合は null を返す。
const LOCK_KEY = 'mtk_app_data:lock';
const LOCK_TTL_SEC = 5;        // ロック自動失効（呼び出し側がクラッシュしても5秒で自動解放）
const LOCK_MAX_WAIT_MS = 6000; // ロック取得を待つ最大時間
const LOCK_RETRY_INTERVAL_MS = 60;

export async function withDataLock(redis, fn) {
  const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let acquired = false;

  while (Date.now() - startedAt < LOCK_MAX_WAIT_MS) {
    const got = await redis.set(LOCK_KEY, lockId, { nx: true, ex: LOCK_TTL_SEC });
    if (got) {
      acquired = true;
      break;
    }
    await new Promise(r => setTimeout(r, LOCK_RETRY_INTERVAL_MS));
  }

  if (!acquired) {
    return { ok: false, busy: true };
  }

  try {
    const result = await fn();
    return { ok: true, result };
  } finally {
    // 期限切れによる別の所有権を考慮し、自分のロックIDの場合のみ削除（best-effort）
    try {
      const current = await redis.get(LOCK_KEY);
      if (current === lockId) {
        await redis.del(LOCK_KEY);
      }
    } catch { /* ignore */ }
  }
}
