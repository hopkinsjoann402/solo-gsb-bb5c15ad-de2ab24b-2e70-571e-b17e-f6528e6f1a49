import { useMemo, useState } from 'react';
import {
  api,
  type SceneShots,
  type Shot,
  type ShotListReport,
  type ShotStatus,
  type Take,
  type TakeResult,
} from '../api';

interface Props {
  report: ShotListReport | null;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  /** 保存后用服务端返回的最新报告即时刷新，无需整页重载 */
  onReport: (r: ShotListReport) => void;
}

const STATUS_LABEL: Record<ShotStatus, string> = {
  pending: '待拍',
  shot: '已拍',
  retake: '需重拍',
};
const STATUS_CLASS: Record<ShotStatus, string> = {
  pending: 'badge-warn',
  shot: 'badge-ok',
  retake: 'badge-danger',
};

/** 镜头清单：按场景维护镜头编号/景别机位/必拍/备注，登记多次拍摄并选择最佳条 */
export function ShotsPanel({ report, run, onReport }: Props) {
  const [sceneFilter, setSceneFilter] = useState(0); // 0 = 全部场景
  const [onlyProblems, setOnlyProblems] = useState(false);

  const scenes = useMemo(() => {
    if (!report) return [];
    return report.scenes.filter((s) => {
      if (sceneFilter && s.sceneId !== sceneFilter) return false;
      if (onlyProblems && s.complete) return false;
      return true;
    });
  }, [report, sceneFilter, onlyProblems]);

  if (!report) return <p className="muted">暂无数据</p>;

  return (
    <div>
      <section className="card">
        <h3>镜头清单</h3>
        <div className="form-row">
          <label className="inline-field">
            按场景筛选
            <select
              value={sceneFilter}
              onChange={(e) => setSceneFilter(Number(e.target.value))}
            >
              <option value={0}>全部场景（{report.scenes.length}）</option>
              {report.scenes.map((s) => (
                <option key={s.sceneId} value={s.sceneId}>
                  #{s.storyIndex} {s.title}（{s.storyTime}）
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              style={{ width: 'auto', minWidth: 0 }}
              checked={onlyProblems}
              onChange={(e) => setOnlyProblems(e.target.checked)}
            />
            只看缺镜头 / 需重拍的场景
          </label>
          <span className="spacer" />
          <span className="badge badge-ok">镜头总数 {report.totalShots}</span>
          <span className={`badge ${report.retakeShotCount ? 'badge-danger' : 'badge-ok'}`}>
            需重拍镜头 {report.retakeShotCount}
          </span>
          <span
            className={`badge ${report.incompleteSceneCount ? 'badge-warn' : 'badge-ok'}`}
          >
            未完成场景 {report.incompleteSceneCount}/{report.scenes.length}
          </span>
        </div>
        <p className="muted small">
          镜头状态由拍摄结果自动计算：<b>待拍</b> = 尚未登记任何拍摄；
          <b className="bad">需重拍</b> = 已拍过但没有可用条；<b className="ok">已拍</b> = 存在可用条。
          可手动指定「最佳条」，未指定时自动取最后一条可用条。只有<b>所有必拍镜头都有可用最佳条</b>时场景才标记完成。
        </p>
      </section>

      {scenes.map((s) => (
        <SceneShotCard key={s.sceneId} scene={s} run={run} onReport={onReport} />
      ))}
      {scenes.length === 0 && (
        <section className="card empty-ok muted">没有符合筛选条件的场景。</section>
      )}
    </div>
  );
}

/* ------------------------------- 场景卡片 ------------------------------- */

function SceneShotCard({
  scene,
  run,
  onReport,
}: {
  scene: SceneShots;
  run: Props['run'];
  onReport: Props['onReport'];
}) {
  const [open, setOpen] = useState(true);
  const [code, setCode] = useState('');
  const [framing, setFraming] = useState('');
  const [required, setRequired] = useState(true);
  const [note, setNote] = useState('');

  const problem = !scene.complete;

  const addShot = () =>
    run(async () => {
      if (!code.trim()) return;
      onReport(
        await api.createShot(scene.sceneId, {
          code: code.trim(),
          framing: framing.trim(),
          required,
          note: note.trim(),
        })
      );
      setCode('');
      setFraming('');
      setRequired(true);
      setNote('');
    });

  return (
    <section className={`card shot-scene ${problem ? 'shot-scene-problem' : 'shot-scene-done'}`}>
      <div className="scene-head" onClick={() => setOpen(!open)}>
        <span className="time-chip">
          {scene.storyTime}
          <em>故事 #{scene.storyIndex}</em>
        </span>
        <h3>{scene.title}</h3>
        <span className={`badge ${scene.complete ? 'badge-ok' : 'badge-warn'}`}>
          {scene.complete ? '✓ 场景完成' : '未完成'}
        </span>
        <span className="muted small">
          必拍 {scene.requiredReady}/{scene.requiredCount}
          {scene.optionalCount > 0 && ` · 选拍 ${scene.optionalReady}/${scene.optionalCount}`}
          {scene.pendingCount > 0 && ` · 待拍 ${scene.pendingCount}`}
        </span>
        {scene.missingRequiredCount > 0 && (
          <span className="badge badge-danger">缺必拍镜头 {scene.missingRequiredCount}</span>
        )}
        {scene.retakeCount > 0 && (
          <span className="badge badge-danger">需重拍 {scene.retakeCount}</span>
        )}
        <span className="spacer" />
        <div className="progress" onClick={(e) => e.stopPropagation()} title="必拍镜头完成度">
          <div className="progress-bar" style={{ width: `${scene.completionPct}%` }} />
          <span className="progress-text">{scene.completionPct}%</span>
        </div>
        <button className="ghost">{open ? '收起 ▲' : '展开 ▼'}</button>
      </div>

      {open && (
        <div className="scene-body">
          {scene.shots.length === 0 && (
            <p className="muted small">该场景还没有镜头——没有必拍镜头时场景不会标记完成。</p>
          )}
          {scene.shots.map((sh) => (
            <ShotRow key={sh.id} shot={sh} run={run} onReport={onReport} />
          ))}

          <div className="form-row shot-add">
            <input
              placeholder="镜头编号，如 1A"
              style={{ flex: '0 0 110px', minWidth: 110 }}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <input
              placeholder="景别 / 机位，如 大全景 · 固定"
              value={framing}
              onChange={(e) => setFraming(e.target.value)}
            />
            <label className="checkbox" title="只有必拍镜头全部有可用最佳条时场景才完成">
              <input
                type="checkbox"
                style={{ width: 'auto', minWidth: 0 }}
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              必拍
            </label>
            <input
              placeholder="备注（可选）"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="primary" onClick={addShot} disabled={!code.trim()}>
              ＋ 添加镜头
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------- 镜头行 ------------------------------- */

function ShotRow({
  shot,
  run,
  onReport,
}: {
  shot: Shot;
  run: Props['run'];
  onReport: Props['onReport'];
}) {
  const [showTakes, setShowTakes] = useState(false);
  const [editing, setEditing] = useState(false);

  const bestTake = shot.takes.find((t) => t.id === shot.bestTakeId) ?? null;

  return (
    <div className={`shot-row shot-status-${shot.status}`}>
      <div className="shot-main">
        <span className={`shot-req ${shot.required ? 'req-yes' : 'req-no'}`} title={shot.required ? '必拍镜头' : '选拍镜头'}>
          {shot.required ? '★' : '☆'}
        </span>
        <b className="shot-code">{shot.code}</b>
        {shot.framing && <span className="time-chip">{shot.framing}</span>}
        <span className={`badge ${STATUS_CLASS[shot.status]}`}>{STATUS_LABEL[shot.status]}</span>
        {bestTake ? (
          <span className="badge badge-ok best-chip" title="当前生效的最佳条">
            ⭐ 最佳条：第 {bestTake.takeNo} 条
          </span>
        ) : (
          shot.required && (
            <span className="badge badge-danger best-chip" title="必拍镜头尚缺可用最佳条">
              缺最佳条
            </span>
          )
        )}
        {shot.bestInvalid && (
          <span className="badge badge-warn best-chip" title="手动选择的最佳条已被删除或标记为不可用，已自动回退">
            手选最佳条已失效
          </span>
        )}
        {shot.note && <span className="muted small shot-note">📝 {shot.note}</span>}
        <span className="spacer" />
        <button className="ghost" onClick={() => setShowTakes(!showTakes)}>
          🎞 拍摄条（{shot.takes.length}）{showTakes ? ' ▲' : ' ▼'}
        </button>
        <button className="ghost" onClick={() => setEditing(!editing)}>
          ✎ 编辑
        </button>
        <button
          className="ghost danger"
          onClick={() => {
            if (window.confirm(`删除镜头 ${shot.code}？其全部拍摄记录将一并删除。`)) {
              void run(async () => onReport(await api.deleteShot(shot.id)));
            }
          }}
        >
          ✕
        </button>
      </div>

      {editing && <ShotEdit shot={shot} run={run} onReport={onReport} onDone={() => setEditing(false)} />}

      {showTakes && <TakesArea shot={shot} run={run} onReport={onReport} />}
    </div>
  );
}

/* ------------------------------- 镜头编辑 ------------------------------- */

function ShotEdit({
  shot,
  run,
  onReport,
  onDone,
}: {
  shot: Shot;
  run: Props['run'];
  onReport: Props['onReport'];
  onDone: () => void;
}) {
  const [code, setCode] = useState(shot.code);
  const [framing, setFraming] = useState(shot.framing);
  const [required, setRequired] = useState(shot.required);
  const [note, setNote] = useState(shot.note);

  const save = () =>
    run(async () => {
      if (!code.trim()) return;
      onReport(
        await api.updateShot(shot.id, {
          code: code.trim(),
          framing: framing.trim(),
          required,
          note: note.trim(),
        })
      );
      onDone();
    });

  return (
    <div className="form-row shot-edit">
      <input
        value={code}
        style={{ flex: '0 0 110px', minWidth: 110 }}
        placeholder="镜头编号"
        onChange={(e) => setCode(e.target.value)}
      />
      <input value={framing} placeholder="景别 / 机位" onChange={(e) => setFraming(e.target.value)} />
      <label className="checkbox">
        <input
          type="checkbox"
          style={{ width: 'auto', minWidth: 0 }}
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        必拍
      </label>
      <input value={note} placeholder="备注" onChange={(e) => setNote(e.target.value)} />
      <button className="primary" onClick={save} disabled={!code.trim()}>
        保存
      </button>
      <button className="ghost" onClick={onDone}>
        取消
      </button>
    </div>
  );
}

/* ------------------------------- 拍摄条区域 ------------------------------- */

function TakesArea({
  shot,
  run,
  onReport,
}: {
  shot: Shot;
  run: Props['run'];
  onReport: Props['onReport'];
}) {
  const [result, setResult] = useState<TakeResult>('usable');
  const [note, setNote] = useState('');

  const addTake = () =>
    run(async () => {
      onReport(await api.addTake(shot.id, { result, note: note.trim() }));
      setNote('');
      setResult('usable');
    });

  return (
    <div className="takes-area">
      {shot.takes.length === 0 && <p className="muted small">尚未拍摄，登记第一条后镜头自动离开「待拍」。</p>}
      {shot.takes.map((t) => (
        <TakeRow key={t.id} shot={shot} take={t} run={run} onReport={onReport} />
      ))}
      <div className="form-row take-add">
        <select
          value={result}
          style={{ flex: '0 0 120px', minWidth: 120 }}
          onChange={(e) => setResult(e.target.value as TakeResult)}
        >
          <option value="usable">✓ 可用</option>
          <option value="ng">✕ 不可用（需重拍）</option>
        </select>
        <input
          placeholder="本条备注：收音问题 / 表演 / 穿帮…（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button className="primary" onClick={addTake}>
          ＋ 登记第 {shot.takes.length + 1} 条
        </button>
      </div>
    </div>
  );
}

function TakeRow({
  shot,
  take,
  run,
  onReport,
}: {
  shot: Shot;
  take: Take;
  run: Props['run'];
  onReport: Props['onReport'];
}) {
  const usable = take.result === 'usable';
  const isBest = shot.bestTakeId === take.id;
  const [editNote, setEditNote] = useState<string | null>(null);

  return (
    <div className={`take-row ${usable ? '' : 'take-ng'} ${isBest ? 'take-best' : ''}`}>
      <span className="take-no">第 {take.takeNo} 条</span>
      <button
        className={`badge ${usable ? 'badge-ok' : 'badge-danger'} take-result`}
        title="点击切换可用 / 不可用，保存后镜头状态与完成度即时重算"
        onClick={() =>
          run(async () =>
            onReport(
              await api.updateTake(take.id, {
                result: usable ? 'ng' : 'usable',
                note: take.note,
              })
            )
          )
        }
      >
        {usable ? '✓ 可用' : '✕ 不可用'}
      </button>
      {isBest ? (
        <button
          className="badge badge-ok"
          title="取消手动选择，改为自动取最后一条可用条"
          onClick={() => run(async () => onReport(await api.chooseBest(shot.id, null)))}
        >
          ⭐ 最佳条 ✕
        </button>
      ) : (
        <button
          className="badge ghost-badge"
          disabled={!usable}
          title={usable ? '设为本镜头的最佳条' : '不可用条不能设为最佳条'}
          onClick={() => run(async () => onReport(await api.chooseBest(shot.id, take.id)))}
        >
          ☆ 设为最佳
        </button>
      )}
      {editNote === null ? (
        <span className="muted small take-note" onClick={() => setEditNote(take.note)}>
          {take.note || '（无备注，点击添加）'}
        </span>
      ) : (
        <>
          <input
            value={editNote}
            autoFocus
            onChange={(e) => setEditNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void run(async () =>
                  onReport(await api.updateTake(take.id, { result: take.result, note: editNote.trim() }))
                );
                setEditNote(null);
              }
            }}
          />
          <button
            className="primary"
            onClick={() =>
              run(async () => {
                onReport(await api.updateTake(take.id, { result: take.result, note: editNote.trim() }));
                setEditNote(null);
              })
            }
          >
            保存备注
          </button>
        </>
      )}
      <span className="spacer" />
      <button
        className="ghost danger"
        title="删除本条"
        onClick={() => {
          if (window.confirm(`删除第 ${take.takeNo} 条拍摄记录？`)) {
            void run(async () => onReport(await api.deleteTake(take.id)));
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}
