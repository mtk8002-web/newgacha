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

// 未初期化なら inventory を構築。新フィールド（gachaPoint/limitBreaks/iconPrize）も同時に補完。idempotent。
export function ensureUserInventory(user) {
  if (!Array.isArray(user.inventory)) {
    user.inventory = buildInventoryFromHistory(user.gachaHistory);
  }
  if (typeof user.gachaPoint !== 'number') user.gachaPoint = 0;
  ensureLimitBreaks(user);
  if (user.iconPrize === undefined) user.iconPrize = null;
}

// limitBreaks の初期化（景品単位の突破段階マップ）
export function ensureLimitBreaks(user) {
  if (!user.limitBreaks || typeof user.limitBreaks !== 'object') {
    user.limitBreaks = {};
  }
}

// 全ユーザーぶん。
export function ensureAllInventories(data) {
  if (!data || !Array.isArray(data.users)) return;
  for (const u of data.users) ensureUserInventory(u);
}

// 同じ prizeKey の別インスタンスが inventory にあるか。
// 限界突破の素材消費対象を探す用。古い方優先で返す。
export function findOtherInstanceOfSamePrize(user, excludeInstanceId, gachaTypeId, prizeId) {
  if (!Array.isArray(user.inventory)) return null;
  const candidates = user.inventory
    .filter(it => it.instanceId !== excludeInstanceId
      && it.gachaTypeId === gachaTypeId
      && it.prizeId === prizeId);
  if (candidates.length === 0) return null;
  // 古い方（acquiredAt 昇順）を返す
  candidates.sort((a, b) => (a.acquiredAt || 0) - (b.acquiredAt || 0));
  return candidates[0];
}

// レアリティを1段階昇格（N→R→SR→SSR→UR、UR は据え置き）。
// 限界突破 ★max 到達時の表示・分解レート計算で使う。
const RARITY_RANK_ORDER = ['N', 'R', 'SR', 'SSR', 'UR'];
export function promoteRarity(rarity) {
  const r = String(rarity || 'N').toUpperCase();
  const idx = RARITY_RANK_ORDER.indexOf(r);
  if (idx < 0) return 'N';
  if (idx >= RARITY_RANK_ORDER.length - 1) return r;
  return RARITY_RANK_ORDER[idx + 1];
}

// limitBreaks が limitBreakMax に達しているか判定し、達していれば昇格レアリティを返す
export function effectiveRarity(baseRarity, lbLevel, lbMax) {
  const level = Math.max(0, Math.floor(Number(lbLevel) || 0));
  const max = Math.max(1, Math.floor(Number(lbMax) || 1));
  return level >= max ? promoteRarity(baseRarity) : String(baseRarity || 'N').toUpperCase();
}

// inventory item から確定的にレアリティを取得（gachaTypes → gachaHistory → 'N' でフォールバック）。
// 分解・限界突破などサーバー側でレアリティ判定が必要な処理で使う。
export function getRarityForInstance(item, gachaTypes, gachaHistory) {
  if (!item) return 'N';
  const t = (gachaTypes || []).find(x => x.id === item.gachaTypeId);
  if (t) {
    if (item.prizeId === `pity-${t.id}` && t.pityPrize) {
      return String(t.pityPrize.rarity || 'UR').toUpperCase();
    }
    const p = (t.prizes || []).find(x => x.id === item.prizeId);
    if (p && p.rarity) return String(p.rarity).toUpperCase();
  }
  // gachaTypes に無ければ gachaHistory で prizeId 一致の最新エントリのレアリティを取る
  if (Array.isArray(gachaHistory)) {
    for (let i = gachaHistory.length - 1; i >= 0; i--) {
      const h = gachaHistory[i];
      if (h && h.prizeId === item.prizeId && h.rarity) {
        return String(h.rarity).toUpperCase();
      }
    }
  }
  return 'N';
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
