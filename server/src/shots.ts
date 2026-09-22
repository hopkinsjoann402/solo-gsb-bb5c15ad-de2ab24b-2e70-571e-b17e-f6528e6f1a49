import { db } from './db.js';
import { computeStoryOrder } from './schedule.js';

/* ================================ 数据类型 ================================ */

/** 镜头状态：pending=待拍（无任何拍摄记录），shot=已拍（存在可用条且有最佳条），retake=需重拍（有条目但全部不可用） */
export type ShotStatus = 'pending' | 'shot' | 'retake';

export type TakeResult = 'usable' | 'ng';

export interface TakeDto {
  id: number;
  shotId: number;
  takeNo: number;
  result: TakeResult;
  note: string;
  createdAt: string;
}

export interface ShotDto {
  id: number;
  sceneId: number;
  code: string; // 镜头编号，如 1A
  framing: string; // 景别/机位，如 大全景 · 固定
  required: boolean; // 是否必拍
  note: string;
  takes: TakeDto[];
  status: ShotStatus;
  chosenBestTakeId: number | null; // 用户手动选择的最佳条（可能指向已删除/不可用条目）
  bestTakeId: number | null; // 实际生效的可用最佳条：优先手动选择，否则自动取最后一条可用条
  bestInvalid: boolean; // 手动选择的最佳条已失效（被删除或标记为不可用）
  usableCount: number;
}

export interface SceneShots {
  sceneId: number;
  title: string;
  storyTime: string;
  seq: number;
  storyIndex: number;
  shots: ShotDto[];
  requiredCount: number;
  requiredReady: number; // 已有可用最佳条的必拍镜头数
  optionalCount: number;
  optionalReady: number;
  pendingCount: number;
  retakeCount: number;
  missingRequiredCount: number; // 缺少可用最佳条的必拍镜头数（待拍 + 需重拍）
  completionPct: number; // 完成度：必拍就绪 / 必拍总数（无镜头 = 0）
  complete: boolean; // 所有必拍镜头均有可用最佳条，且至少定义了一个必拍镜头
}

export interface ShotListReport {
  generatedAt: string;
  scenes: SceneShots[];
  totalShots: number;
  incompleteSceneCount: number;
  retakeShotCount: number;
}

/* ================================ 引擎 ================================ */

interface SceneRow {
  id: number;
  title: string;
  story_time: string;
  seq: number;
}
interface ShotRow {
  id: number;
  scene_id: number;
  code: string;
  framing: string;
  required: number;
  note: string;
  best_take_id: number | null;
}
interface TakeRow {
  id: number;
  shot_id: number;
  take_no: number;
  result: string;
  note: string;
  created_at: string;
}

/**
 * 镜头清单现算（与连续性重放、拍摄排程完全独立）：
 * - 镜头状态：无拍摄条目 => 待拍；有条目但无可用条 => 需重拍；存在可用条 => 已拍；
 * - 最佳条：优先使用手动选择且仍可用的条目，否则自动取该镜头最后一条可用条；
 * - 场景完成度 = 已有可用最佳条的必拍镜头 / 必拍镜头总数；
 *   只有「必拍镜头全部有可用最佳条」时场景才标记完成。
 */
export function computeShotList(): ShotListReport {
  const sceneRows = db
    .prepare('SELECT id, title, story_time, seq FROM scenes ORDER BY story_time ASC, seq ASC, id ASC')
    .all() as SceneRow[];
  const storyIndex = computeStoryOrder(sceneRows);

  const shotRows = db
    .prepare('SELECT * FROM shots ORDER BY scene_id ASC, code ASC, id ASC')
    .all() as ShotRow[];
  const takeRows = db
    .prepare('SELECT * FROM takes ORDER BY shot_id ASC, take_no ASC, id ASC')
    .all() as TakeRow[];

  const takesByShot = new Map<number, TakeRow[]>();
  for (const t of takeRows) {
    const list = takesByShot.get(t.shot_id) ?? [];
    list.push(t);
    takesByShot.set(t.shot_id, list);
  }
  const shotsByScene = new Map<number, ShotRow[]>();
  for (const s of shotRows) {
    const list = shotsByScene.get(s.scene_id) ?? [];
    list.push(s);
    shotsByScene.set(s.scene_id, list);
  }

  let totalShots = 0;
  let incompleteSceneCount = 0;
  let retakeShotCount = 0;

  const scenes: SceneShots[] = sceneRows.map((sc) => {
    const rows = shotsByScene.get(sc.id) ?? [];
    const shots: ShotDto[] = rows.map((r) => {
      const takes: TakeDto[] = (takesByShot.get(r.id) ?? []).map((t) => ({
        id: t.id,
        shotId: r.id,
        takeNo: t.take_no,
        result: (t.result === 'ng' ? 'ng' : 'usable') as TakeResult,
        note: t.note,
        createdAt: t.created_at,
      }));
      const usable = takes.filter((t) => t.result === 'usable');
      const autoBest = usable.length > 0 ? usable[usable.length - 1].id : null;
      const chosen = r.best_take_id;
      const chosenTake = chosen != null ? takes.find((t) => t.id === chosen) : undefined;
      const chosenUsable = chosenTake?.result === 'usable' ? chosenTake : null;
      const bestTakeId = chosenUsable ? chosenUsable.id : autoBest;
      const status: ShotStatus =
        takes.length === 0 ? 'pending' : usable.length === 0 ? 'retake' : 'shot';
      if (status === 'retake') retakeShotCount += 1;
      return {
        id: r.id,
        sceneId: sc.id,
        code: r.code,
        framing: r.framing,
        required: r.required !== 0,
        note: r.note,
        takes,
        status,
        chosenBestTakeId: chosen,
        bestTakeId,
        bestInvalid: chosen != null && chosenUsable === null,
        usableCount: usable.length,
      };
    });
    totalShots += shots.length;

    const required = shots.filter((s) => s.required);
    const optional = shots.filter((s) => !s.required);
    const isReady = (s: ShotDto) => s.bestTakeId != null;
    const requiredReady = required.filter(isReady).length;
    const optionalReady = optional.filter(isReady).length;
    const pendingCount = shots.filter((s) => s.status === 'pending').length;
    const retakeCount = shots.filter((s) => s.status === 'retake').length;
    const missingRequiredCount = required.length - requiredReady;
    const completionPct =
      required.length === 0 ? 0 : Math.round((requiredReady / required.length) * 100);
    const complete = required.length > 0 && requiredReady === required.length;
    if (!complete) incompleteSceneCount += 1;

    return {
      sceneId: sc.id,
      title: sc.title,
      storyTime: sc.story_time,
      seq: sc.seq,
      storyIndex: storyIndex.get(sc.id)!,
      shots,
      requiredCount: required.length,
      requiredReady,
      optionalCount: optional.length,
      optionalReady,
      pendingCount,
      retakeCount,
      missingRequiredCount,
      completionPct,
      complete,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    scenes,
    totalShots,
    incompleteSceneCount,
    retakeShotCount,
  };
}
