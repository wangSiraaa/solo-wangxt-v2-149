import type { Keyframe, TrackedPolygon, TrackingGap } from '../types';
import { formatTime } from '../lib/geometry';

type TimelineProps = {
  durationSec: number;
  currentSec: number;
  keyframes: Keyframe[];
  trackedPolygons: TrackedPolygon[];
  gaps: TrackingGap[];
  onSeek: (timeSec: number) => void;
};

export function Timeline({ durationSec, currentSec, keyframes, trackedPolygons, gaps, onSeek }: TimelineProps) {
  const trackedRanges: Array<{ left: string; width: string }> = [];
  if (trackedPolygons.length > 0) {
    let start = trackedPolygons[0].timeSec;
    let previous = start;
    for (let i = 1; i <= trackedPolygons.length; i += 1) {
      const current = trackedPolygons[i]?.timeSec;
      if (current === undefined || current - previous > 0.12) {
        trackedRanges.push({
          left: `${(start / durationSec) * 100}%`,
          width: `${Math.max(0.5, ((previous - start) / durationSec) * 100)}%`
        });
        if (current !== undefined) start = current;
      }
      if (current !== undefined) previous = current;
    }
  }

  return (
    <div className="panel timeline">
      <div className="row spread">
        <strong>时间轴</strong>
        <span className="muted">{formatTime(currentSec)} / {formatTime(durationSec)} · 按解码 PTS 秒定位</span>
      </div>
      <input
        type="range"
        min={0}
        max={durationSec}
        step={0.001}
        value={Math.min(currentSec, durationSec)}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="按实际时间定位"
      />
      <div className="tick-row">
        {trackedRanges.map((range, index) => (
          <div key={`tracked-${index}`} className="tracked-segment" style={{ left: range.left, width: range.width }} />
        ))}
        {gaps.map((gap, index) => (
          <div
            key={`gap-${index}`}
            className="gap-segment"
            title={`人工等待区间 ${formatTime(gap.startSec)}-${formatTime(gap.endSec)}：${gap.reason}`}
            style={{
              left: `${(gap.startSec / durationSec) * 100}%`,
              width: `${Math.max(0.5, ((gap.endSec - gap.startSec) / durationSec) * 100)}%`
            }}
          />
        ))}
        {keyframes.map((key) => (
          <button
            key={key.id}
            className={`keyframe-tick ${Math.abs(key.timeSec - currentSec) < 0.02 ? 'active' : ''}`}
            style={{ left: `${(key.timeSec / durationSec) * 100}%` }}
            title={`人工关键帧 ${formatTime(key.timeSec)}`}
            onClick={() => onSeek(key.timeSec)}
            aria-label={`跳转关键帧 ${formatTime(key.timeSec)}`}
          />
        ))}
        <div className="scrub-tick" style={{ left: `${(currentSec / durationSec) * 100}%` }} />
      </div>
      <div className="muted">绿色=已验证轨迹；黄色=置信下降/出画暂停缺口；蓝/黄竖线=人工关键帧。缺口不会被自动插值冒充完成。</div>
    </div>
  );
}
