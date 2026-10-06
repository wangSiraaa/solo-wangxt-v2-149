import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Keyframe,
  Polygon,
  Project,
  TrackedPolygon,
  TrackingGap,
  TrackingStatus
} from './types';
import { detectCapabilities, type CapabilityReport } from './lib/capabilities';
import { CanvasViewer } from './components/CanvasViewer';
import { Timeline } from './components/Timeline';
import { importVideoFile, loadMediaFromOpfs, type LoadedMedia } from './lib/mediaService';
import { generateSample, type SampleKind } from './lib/sampleGenerator';
import {
  clamp,
  closestByTime,
  formatTime,
  polygonArea,
  sortedByTime,
  uid,
  validatePolygon
} from './lib/geometry';
import { mergeGaps, mergeTrackedPolygons, runForwardTracking } from './lib/trackingEngine';
import { coverageSummary, downloadMaskExport, replayMaskAtTime } from './lib/maskExport';
import { listProjects, saveProject } from './lib/projectsDb';

type FrameItem = LoadedMedia['frames'][number];
type GeometryDraft = { rotationDegrees: -1 | 0 | 90 | 180 | 270; pixelAspectWidth: string; pixelAspectHeight: string };

const DEFAULT_DRAFT: Polygon = [
  { x: 0.2, y: 0.37 },
  { x: 0.63, y: 0.37 },
  { x: 0.63, y: 0.63 },
  { x: 0.2, y: 0.63 }
];

export default function App() {
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [media, setMedia] = useState<LoadedMedia | null>(null);
  const [currentSec, setCurrentSec] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [keyframes, setKeyframes] = useState<Keyframe[]>([]);
  const [trackedPolygons, setTrackedPolygons] = useState<TrackedPolygon[]>([]);
  const [gaps, setGaps] = useState<TrackingGap[]>([]);
  const [trackingStatus, setTrackingStatus] = useState<TrackingStatus>({ kind: 'idle' });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Polygon>(DEFAULT_DRAFT);
  const [geometryDraft, setGeometryDraft] = useState<GeometryDraft>({
    rotationDegrees: -1,
    pixelAspectWidth: '',
    pixelAspectHeight: ''
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [savedProjects, setSavedProjects] = useState<Project[]>([]);
  const playStartRef = useRef<{ wallMs: number; mediaSec: number } | null>(null);
  const cancelTrackingRef = useRef({ cancelled: false });
  const stateRef = useRef({ keyframes, trackedPolygons, gaps });

  useEffect(() => {
    detectCapabilities().then(async (report) => {
      setCapabilities(report);
      if (report.indexedDb) setSavedProjects(await listProjects());
    });
  }, []);

  useEffect(() => {
    stateRef.current = { keyframes, trackedPolygons, gaps };
  }, [keyframes, trackedPolygons, gaps]);

  const addLog = useCallback((message: string) => {
    setLogs((current) => [`${new Date().toLocaleTimeString()}  ${message}`, ...current].slice(0, 80));
  }, []);

  const durationSec = media?.metadata.durationSec ?? 0;
  const currentFrame = useMemo(() => {
    if (!media) return null;
    return closestByTime(media.frames, currentSec) ?? null;
  }, [currentSec, media]);

  const activeMask = useMemo(() => {
    if (!media) return null;
    return replayMaskAtTime(currentSec, keyframes, trackedPolygons, gaps);
  }, [currentSec, gaps, keyframes, media, trackedPolygons]);

  useEffect(() => {
    if (!playing || !durationSec) return;
    playStartRef.current = { wallMs: performance.now(), mediaSec: currentSec };
    let frameHandle = 0;
    const tick = () => {
      const start = playStartRef.current;
      if (!start) return;
      const next = start.mediaSec + (performance.now() - start.wallMs) / 1000;
      if (next >= durationSec) {
        setCurrentSec(durationSec);
        setPlaying(false);
        return;
      }
      setCurrentSec(next);
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameHandle);
  }, [currentSec, durationSec, playing]);

  const applyLoadedMedia = useCallback((loaded: LoadedMedia) => {
    setMedia(loaded);
    setCurrentSec(0);
    setPlaying(false);
    setKeyframes([]);
    setTrackedPolygons([]);
    setGaps([]);
    setTrackingStatus({ kind: 'idle' });
    setEditing(false);
    setDraft(DEFAULT_DRAFT);
    setGeometryDraft({
      rotationDegrees: -1,
      pixelAspectWidth: String(loaded.metadata.pixelAspectWidth),
      pixelAspectHeight: String(loaded.metadata.pixelAspectHeight)
    });
    addLog(`已解码 ${loaded.metadata.frameCount} 帧；显示方向=${loaded.metadata.rotationDegrees}°，PAR=${loaded.metadata.pixelAspectWidth}:${loaded.metadata.pixelAspectHeight}`);
  }, [addLog]);

  const handleImport = useCallback(async (file: File) => {
    const parWText = geometryDraft.pixelAspectWidth.trim();
    const parHText = geometryDraft.pixelAspectHeight.trim();
    const parW = Number(parWText);
    const parH = Number(parHText);
    if ((parWText && (!Number.isFinite(parW) || parW <= 0)) || (parHText && (!Number.isFinite(parH) || parH <= 0))) {
      setError('像素比例 PAR 必须是正数；留空表示读取容器元数据');
      return;
    }
    const hasParOverride = Boolean(parWText || parHText);
    const parOverride = hasParOverride
      ? { pixelAspectWidth: parWText ? parW : 1, pixelAspectHeight: parHText ? parH : 1 }
      : {};
    setError(null);
    setBusy(`正在把 ${file.name} 写入 OPFS 并用 WebCodecs 解码…`);
    try {
      const useParsedGeometry = geometryDraft.rotationDegrees === -1
        && geometryDraft.pixelAspectWidth.trim() === ''
        && geometryDraft.pixelAspectHeight.trim() === '';
      const override = useParsedGeometry ? {} : {
        rotationDegrees: geometryDraft.rotationDegrees === -1 ? undefined : geometryDraft.rotationDegrees,
        pixelAspectWidth: parOverride.pixelAspectWidth,
        pixelAspectHeight: parOverride.pixelAspectHeight
      };
      const loaded = await importVideoFile(file, override);
      applyLoadedMedia(loaded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }, [applyLoadedMedia, geometryDraft]);

  const handleSample = useCallback(async (kind: SampleKind) => {
    setError(null);
    setBusy('正在用 WebCodecs 现场编码自制 H.264 样本并写入 OPFS…');
    try {
      const { loaded } = await generateSample(kind);
      applyLoadedMedia(loaded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }, [applyLoadedMedia]);

  const seekToFrame = useCallback((timeSec: number) => {
    setPlaying(false);
    setCurrentSec(clamp(timeSec, 0, durationSec));
  }, [durationSec]);

  const saveCurrentKeyframe = useCallback(() => {
    if (!media) return;
    const invalid = validatePolygon(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    const existingIndex = keyframes.findIndex((key) => Math.abs(key.timeSec - currentSec) < 0.001);
    const key: Keyframe = existingIndex >= 0
      ? { ...keyframes[existingIndex], polygon: draft }
      : { id: uid('key'), timeSec: currentSec, polygon: draft };
    setKeyframes((items) => sortedByTime(existingIndex >= 0 ? items.map((item, index) => index === existingIndex ? key : item) : [...items, key]));
    setTrackedPolygons((items) => items.filter((item) => item.timeSec < key.timeSec - 0.001));
    setGaps((items) => items.filter((gap) => gap.endSec < key.timeSec));
    setTrackingStatus((status) => status.kind === 'ready-to-continue'
      ? { kind: 'ready-to-continue', atSec: key.timeSec, reason: '人工关键帧已保存，可以从该时间继续' }
      : { kind: 'idle' });
    setEditing(false);
    addLog(`已保存人工关键帧 @ ${formatTime(key.timeSec)}；这是之后光流段的唯一起点。`);
  }, [addLog, currentSec, draft, keyframes, media]);

  const beginEdit = useCallback(() => {
    setPlaying(false);
    const exact = closestByTime(keyframes.filter((key) => Math.abs(key.timeSec - currentSec) < 0.02), currentSec);
    setDraft(exact?.polygon ?? activeMask?.polygon ?? DEFAULT_DRAFT);
    setEditing(true);
  }, [activeMask, currentSec, keyframes]);

  const runTracking = useCallback(async () => {
    if (!media || keyframes.length === 0) {
      setError('请先在当前时间保存至少一个人工关键帧');
      return;
    }
    const start = [...keyframes].reverse().find((key) => key.timeSec <= currentSec + 1e-6) ?? keyframes[0];
    setPlaying(false);
    setError(null);
    setEditing(false);
    setBusy(null);
    cancelTrackingRef.current = { cancelled: false };
    setTrackingStatus({ kind: 'running', fromSec: start.timeSec, processedSec: start.timeSec, toSec: durationSec });
    addLog(`从人工关键帧 ${formatTime(start.timeSec)} 开始 OpenCV LK 光流 + RANSAC 仿射跟踪。`);

    const additions: TrackedPolygon[] = [];
    const result = await runForwardTracking({
      frames: media.frames,
      startKeyframe: start,
      endSec: durationSec,
      signal: cancelTrackingRef.current,
      onProgress: (processedSec, item) => {
        additions.push(item);
        setTrackingStatus({ kind: 'running', fromSec: start.timeSec, processedSec, toSec: durationSec });
        setCurrentSec(processedSec);
      }
    });

    if (additions.length > 0) {
      setTrackedPolygons((existing) => mergeTrackedPolygons(existing, additions));
    }

    if (result.pause) {
      const gap: TrackingGap = {
        startSec: result.pause.atSec,
        endSec: durationSec,
        reason: result.pause.reason
      };
      setGaps((existing) => mergeGaps(existing, gap));
      setCurrentSec(result.pause.atSec);
      setTrackingStatus({
        kind: 'ready-to-continue',
        atSec: result.pause.atSec,
        reason: result.pause.reason
      });
      setDraft(closestByTime(additions, result.pause.atSec)?.polygon ?? start.polygon);
      addLog(`暂停 @ ${formatTime(result.pause.atSec)}：${result.pause.reason}`);
    } else if (cancelTrackingRef.current.cancelled) {
      setTrackingStatus({ kind: 'idle' });
      addLog('跟踪已手动取消。');
    } else {
      const relevantGaps = stateRef.current.gaps.filter((gap) => gap.startSec >= start.timeSec - 0.01);
      const openTailGap = relevantGaps.find((gap) => gap.endSec >= durationSec - 0.05);
      setTrackingStatus(openTailGap
        ? { kind: 'paused', atSec: openTailGap.startSec, reason: openTailGap.reason, confidence: 0, fromSec: start.timeSec }
        : { kind: 'complete', toSec: durationSec, gaps: relevantGaps });
      addLog(openTailGap
        ? '到达末尾，但尾部仍有未闭合缺口；结果不是完整完成状态。'
        : relevantGaps.length > 0
          ? '已到达媒体末尾；较早缺口仍需人工确认，但不冒充连续全覆盖。'
          : '已到达媒体末尾，当前人工关键帧之后没有未闭合缺口。');
    }
  }, [addLog, durationSec, keyframes, media, currentSec]);

  const continueAfterManualKey = useCallback(async () => {
    await runTracking();
  }, [runTracking]);

  const stopTracking = useCallback(() => {
    cancelTrackingRef.current.cancelled = true;
  }, []);

  const openProject = useCallback(async (project: Project) => {
    setError(null);
    setBusy('正在从 OPFS 读取媒体，并依据工程几何重新解码…');
    try {
      const loaded = await loadMediaFromOpfs(project.media);
      applyLoadedMedia(loaded);
      setKeyframes(project.keyframes);
      setTrackedPolygons(project.trackedPolygons);
      setGaps(project.gaps);
      setTrackingStatus(project.gaps.some((gap) => gap.endSec >= project.media.durationSec - 0.05)
        ? { kind: 'paused', atSec: project.gaps[0]?.startSec ?? 0, reason: '已保存工程含未闭合尾部缺口', confidence: 0, fromSec: project.keyframes[0]?.timeSec ?? 0 }
        : { kind: 'complete', toSec: project.media.durationSec, gaps: project.gaps });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }, [applyLoadedMedia]);

  const persistProject = useCallback(async () => {
    if (!media) return;
    const project: Project = {
      version: 1,
      id: media.metadata.mediaId,
      name: media.metadata.originalName,
      mediaId: media.metadata.mediaId,
      media: media.metadata,
      keyframes,
      trackedPolygons,
      gaps,
      updatedAt: new Date().toISOString()
    };
    await saveProject(project);
    setSavedProjects(await listProjects());
    addLog('遮罩工程已保存到 IndexedDB；媒体仍在 OPFS，原视频未被覆盖。');
  }, [addLog, gaps, keyframes, media, trackedPolygons]);

  const exportMask = useCallback(async () => {
    if (!media) return;
    await downloadMaskExport({ media: media.metadata, keyframes, trackedPolygons, gaps });
    addLog('已导出可重放 JSON 遮罩元数据。');
  }, [addLog, gaps, keyframes, media, trackedPolygons]);

  const summary = coverageSummary(trackedPolygons, durationSec);
  const latestTracked = currentFrame ? closestByTime(trackedPolygons, currentFrame.timeSec) : null;
  const completionRatio = durationSec > 0 && keyframes.length > 0
    ? trackedPolygons.length / Math.max(1, media?.frames.length ?? 1)
    : 0;

  if (capabilities === null) return <div className="app"><div className="panel">正在检测浏览器能力…</div></div>;

  return (
    <div className="app">
      <header className="app-header">
        <h1>纯浏览器移动标牌遮罩光流跟踪台</h1>
        <p>React + TypeScript 管理时间轴；WebCodecs 解码 MP4/H.264；OpenCV.js 光流/仿射；OPFS 存媒体，IndexedDB 存工程。</p>
      </header>
      {!capabilities.supported && (
        <div className="capability-banner">
          <strong>当前浏览器能力不足，以下功能无法可靠运行：</strong>
          <ul>{capabilities.messages.map((message) => <li key={message}>{message}</li>)}</ul>
          <p className="muted">请使用桌面版最新 Chrome / Edge / Chromium，并通过 http(s) 访问（file:// 下可能禁用部分能力）。</p>
        </div>
      )}
      {capabilities.supported && (
        <div className="capability-banner ok">
          能力检查通过：WebCodecs、H.264、WebAssembly/OpenCV.js、OPFS、IndexedDB 均可使用。
        </div>
      )}

      <main className="main">
        <section className="workspace">
          <div className="panel">
            <div className="row spread">
              <div className="row">
                <label className="file-label">
                  <input
                    type="file"
                    accept="video/mp4;codecs=avc1,video/mp4"
                    disabled={!capabilities.supported}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void handleImport(file);
                    }}
                  />
                </label>
              </div>
              <div className="row">
                <button disabled={!capabilities.supported || busy !== null} onClick={() => void handleSample('movement')}>生成清晰移动样本</button>
                <button disabled={!capabilities.supported || busy !== null} onClick={() => void handleSample('motion-blur')}>生成模糊样本</button>
                <button disabled={!capabilities.supported || busy !== null} onClick={() => void handleSample('exit-frame')}>生成出画样本</button>
              </div>
            </div>
            <div className="geometry-grid" style={{ marginTop: 10 }}>
              <label className="small">容器旋转（明确覆盖）
                <select
                  value={geometryDraft.rotationDegrees}
                  onChange={(event) => setGeometryDraft((d) => ({ ...d, rotationDegrees: Number(event.target.value) as -1 | 0 | 90 | 180 | 270 }))}
                >
                  <option value={-1}>自动读取容器</option>
                  <option value={0}>强制 0°</option>
                  <option value={90}>90°</option>
                  <option value={180}>180°</option>
                  <option value={270}>270°</option>
                </select>
              </label>
              <label className="small">PAR 宽
                <input value={geometryDraft.pixelAspectWidth} onChange={(event) => setGeometryDraft((d) => ({ ...d, pixelAspectWidth: event.target.value }))} />
              </label>
              <label className="small">PAR 高
                <input value={geometryDraft.pixelAspectHeight} onChange={(event) => setGeometryDraft((d) => ({ ...d, pixelAspectHeight: event.target.value }))} />
              </label>
            </div>
            <p className="muted">旋转/PAR 在导入或生成前显式指定；导入后会写入工程几何信息。自制“清晰移动”样本在容器中为 90° 且使用 3:4 PAR 覆盖来验证显示坐标。</p>
            {busy && <div className="warning-box">{busy}</div>}
            {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}
          </div>

          {media && currentFrame && (
            <>
              <div className="panel">
                <div className="row spread">
                  <div className="row">
                    <button onClick={() => setPlaying((value) => !value)}>{playing ? '暂停' : '播放'}</button>
                    <button onClick={() => seekToFrame(0)}>回到开头</button>
                    <button onClick={beginEdit}>{editing ? '继续编辑' : '编辑/新增关键帧'}</button>
                    <button className="primary" disabled={!editing} onClick={saveCurrentKeyframe}>保存人工关键帧</button>
                  </div>
                  <StatusBadge status={trackingStatus} />
                </div>
                <CanvasViewer
                  frame={currentFrame}
                  polygon={activeMask?.polygon ?? null}
                  draftPolygon={draft}
                  editing={editing}
                  onChangeDraft={setDraft}
                />
                {editing && (
                  <div className="warning-box" style={{ marginTop: 10 }}>
                    点击空白添加顶点；拖动顶点调整；双击顶点删除（至少 3 点）；双击边插入点。确认后请保存人工关键帧。
                  </div>
                )}
                {activeMask?.status === 'gap' && (
                  <div className="error-box" style={{ marginTop: 10 }}>
                    当前时间处于未确认缺口：系统不会显示猜测遮罩。请调整黄色多边形并保存人工关键帧，然后继续。
                  </div>
                )}
              </div>
              <Timeline
                durationSec={durationSec}
                currentSec={currentSec}
                keyframes={keyframes}
                trackedPolygons={trackedPolygons}
                gaps={gaps}
                onSeek={seekToFrame}
              />
            </>
          )}
        </section>

        <aside className="sidebar">
          <div className="panel">
            <h2>跟踪控制</h2>
            <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <button className="primary" disabled={!media || keyframes.length === 0 || trackingStatus.kind === 'running'} onClick={() => void runTracking()}>
                从最近人工关键帧跟踪到末尾
              </button>
              <button disabled={trackingStatus.kind !== 'running'} onClick={stopTracking}>取消当前跟踪</button>
              <button className="primary" disabled={trackingStatus.kind !== 'ready-to-continue'} onClick={() => void continueAfterManualKey()}>
                保存新关键帧后继续
              </button>
              <button disabled={!media} onClick={() => void persistProject()}>保存工程到 IndexedDB</button>
              <button disabled={!media || keyframes.length === 0} onClick={() => void exportMask()}>导出遮罩 JSON</button>
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              暂停后不会自动续跑。必须人工检查、保存新关键帧，系统才会从该真实关键帧重新生成候选轨迹。
            </p>
          </div>

          <div className="panel">
            <h2>已保存工程</h2>
            {savedProjects.length === 0
              ? <div className="muted">暂无 IndexedDB 工程。保存后可从这里配合 OPFS 媒体重新打开。</div>
              : savedProjects.map((project) => (
                <div className="row spread" key={project.id} style={{ marginBottom: 8 }}>
                  <div>
                    <div>{project.name}</div>
                    <div className="muted">{project.keyframes.length} 个关键帧 · {project.trackedPolygons.length} 个轨迹点</div>
                  </div>
                  <button onClick={() => void openProject(project)}>打开</button>
                </div>
              ))}
          </div>

          {media && (
            <div className="panel">
              <h2>媒体与时间戳</h2>
              <dl className="kv">
                <dt>文件</dt><dd>{media.metadata.originalName}</dd>
                <dt>格式</dt><dd>MP4 / {media.metadata.codec}</dd>
                <dt>解码尺寸</dt><dd>{media.metadata.codedWidth} × {media.metadata.codedHeight}</dd>
                <dt>旋转 / PAR</dt><dd>{media.metadata.rotationDegrees}° / {media.metadata.pixelAspectWidth}:{media.metadata.pixelAspectHeight}</dd>
                <dt>帧数</dt><dd>{media.metadata.frameCount}</dd>
                <dt>时长</dt><dd>{formatTime(media.metadata.durationSec)}</dd>
                <dt>当前 PTS</dt><dd>{formatTime(currentSec)}（秒，非数组下标）</dd>
              </dl>
            </div>
          )}

          <div className="panel">
            <h2>置信度与覆盖</h2>
            <div className="metrics">
              <div className="metric"><b>{(latestTracked?.confidence ?? 0).toFixed(3)}</b><span className="muted">最近帧置信度</span></div>
              <div className="metric"><b>{latestTracked?.inlierCount ?? 0}</b><span className="muted">RANSAC 内点</span></div>
              <div className="metric"><b>{latestTracked ? latestTracked.backwardError.toFixed(4) : '—'}</b><span className="muted">归一化反向误差</span></div>
              <div className="metric"><b>{Math.round(completionRatio * 100)}%</b><span className="muted">已产出轨迹比例</span></div>
            </div>
            <p className="muted">平均置信度 {summary.meanConfidence.toFixed(3)}；低置信点 {summary.lowConfidenceCount}。覆盖率不足或存在黄段时，状态不会宣称“完成”。</p>
          </div>

          <div className="panel">
            <h2>顶点</h2>
            <div className="point-list">
              {(editing ? draft : activeMask?.polygon ?? []).map((point, index) => (
                <div key={index}>{String(index + 1).padStart(2, '0')}  x={point.x.toFixed(4)} y={point.y.toFixed(4)}</div>
              ))}
              {(editing ? draft : activeMask?.polygon ?? []).length === 0 && <div className="muted">当前没有遮罩</div>}
            </div>
            <p className="muted">面积 {polygonArea(editing ? draft : activeMask?.polygon ?? []).toFixed(5)}（归一化画面）</p>
          </div>

          <div className="panel">
            <h2>运行日志</h2>
            <div className="log">{logs.join('\n') || '暂无日志'}</div>
          </div>
        </aside>
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: TrackingStatus }) {
  if (status.kind === 'running') return <span className="status-pill running">跟踪中 {formatTime(status.processedSec)}</span>;
  if (status.kind === 'paused') return <span className="status-pill paused">暂停 @{formatTime(status.atSec)}</span>;
  if (status.kind === 'ready-to-continue') return <span className="status-pill paused">等待人工关键帧 @{formatTime(status.atSec)}</span>;
  if (status.kind === 'complete') return <span className="status-pill complete">到达末尾</span>;
  return <span className="status-pill">待跟踪</span>;
}
