// ユーザーの所持景品管理。
// gachaHistory は不変な抽選履歴。inventory は現在所持しているインスタンスのリスト。
// 各 inventory アイテムは instanceId で一意にトラッキングされ、トレードで譲渡される。

// ランダム instanceId（pull や受け取り時に新規生成）
export function makeInstanceId() {
  return 'inv-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

// マイグレーション専用の決定的 instanceId（GET時に再生成しても同じIDが出るようにする）
function migrationInstanceId(historyIndex) {
  return `inv-mig-${historyIndex}`;
}

// gachaHistory から inventory を構築。各履歴 = 1 インスタンス。
function buildInventoryFromHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((h, i) => ({
    instanceId: migrationInstanceId(i),
    prizeId: h.prizeId || '',
    gachaTypeId: h.gachaTypeId || '',
    acquiredAt: h.timestamp || 0,
    isPity: !!h.isPity,
  }));
}

// 未初期化なら inventory を構築。既存の場合は触らない（idempotent）。
export function ensureUserInventory(user) {
  if (Array.isArray(user.inventory)) return;
  user.inventory = buildInventoryFromHistory(user.gachaHistory);
}

// 全ユーザーぶん。
export function ensureAllInventories(data) {
  if (!data || !Array.isArray(data.users)) return;
  for (const u of data.users) ensureUserInventory(u);
}

// base64 画像かどうか（容量肥大対策）
export function isBase64Image(v) {
  return typeof v === 'string' && v.startsWith('data:image');
}
export function thinIcon(icon) {
  return isBase64Image(icon) ? '' : (icon || '');
}

// 旧仕様で trade に base64 アイコン（出品者アバター/景品画像）が保存されていた場合のマイグレーション。
// 全 writer（pull/data/trade）の SET 前に呼ぶ。
export function sanitizeAllTradeIcons(data) {
  if (!data || !Array.isArray(data.trades)) return;
  for (const t of data.trades) {
    if (isBase64Image(t.ownerIcon)) t.ownerIcon = '';
    if (t.ownerItem && t.ownerItem.snapshot) {
      // 新仕様では snapshot に icon を保存しない
      if (isBase64Image(t.ownerItem.snapshot.prizeIcon)) delete t.ownerItem.snapshot.prizeIcon;
      if (t.ownerItem.snapshot.prizeIconType) delete t.ownerItem.snapshot.prizeIconType;
    }
    if (Array.isArray(t.offers)) {
      for (const o of t.offers) {
        if (isBase64Image(o.offererIcon)) o.offererIcon = '';
        if (o.item && o.item.snapshot) {
          if (isBase64Image(o.item.snapshot.prizeIcon)) delete o.item.snapshot.prizeIcon;
          if (o.item.snapshot.prizeIconType) delete o.item.snapshot.prizeIconType;
        }
      }
    }
  }
}

// 表示用 snapshot：景品名・レアリティ・ガチャ名のみを保存。アイコンは保存しない。
// 容量肥大を避けるため、表示時に prizeId / gachaTypeId から gachaTypes を参照して解決する。
// 景品が後で削除された場合は名前・レアリティだけは snapshot から取り出せる。
export function snapshotPrize(inventoryItem, gachaTypes) {
  const t = (gachaTypes || []).find(x => x.id === inventoryItem.gachaTypeId);
  if (t) {
    if (inventoryItem.prizeId === `pity-${t.id}` && t.pityPrize) {
      return {
        prizeName: t.pityPrize.name,
        rarity: t.pityPrize.rarity || 'UR',
        gachaTypeName: t.name,
      };
    }
    const p = (t.prizes || []).find(x => x.id === inventoryItem.prizeId);
    if (p) {
      return {
        prizeName: p.name,
        rarity: p.rarity || 'N',
        gachaTypeName: t.name,
      };
    }
  }
  return { prizeName: '(削除された景品)', rarity: 'N', gachaTypeName: '' };
}
