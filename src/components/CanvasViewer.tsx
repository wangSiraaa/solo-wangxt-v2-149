import { useEffect, useMemo, useRef, useState } from 'react';
import type { Polygon } from '../types';

type CanvasViewerProps = {
  frame: { canvas: HTMLCanvasElement; timeSec: number } | null;
  polygon: Polygon | null;
  draftPolygon: Polygon | null;
  editing: boolean;
  onChangeDraft: (polygon: Polygon) => void;
};

function drawPolygon(ctx: CanvasRenderingContext2D, polygon: Polygon, color: string, lineWidth: number, fillAlpha: number): void {
  if (polygon.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(polygon[0].x * ctx.canvas.width, polygon[0].y * ctx.canvas.height);
  for (let i = 1; i < polygon.length; i += 1) ctx.lineTo(polygon[i].x * ctx.canvas.width, polygon[i].y * ctx.canvas.height);
  if (polygon.length >= 3) {
    ctx.closePath();
    ctx.fillStyle = color.replace(')', `, ${fillAlpha})`).replace('rgb', 'rgba');
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

export function CanvasViewer({ frame, polygon, draftPolygon, editing, onChangeDraft }: CanvasViewerProps) {
  const videoRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const activePolygon = editing ? draftPolygon : polygon;

  useEffect(() => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!frame || !video || !overlay) return;
    video.width = frame.canvas.width;
    video.height = frame.canvas.height;
    overlay.width = frame.canvas.width;
    overlay.height = frame.canvas.height;
    const videoCtx = video.getContext('2d');
    const overlayCtx = overlay.getContext('2d');
    if (!videoCtx || !overlayCtx) return;
    videoCtx.clearRect(0, 0, video.width, video.height);
    videoCtx.drawImage(frame.canvas, 0, 0);
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

    if (polygon && !editing) {
      drawPolygon(overlayCtx, polygon, 'rgb(34,211,238)', 2.5, 0.18);
      overlayCtx.fillStyle = 'rgba(34,211,238,0.95)';
      for (const point of polygon) {
        overlayCtx.beginPath();
        overlayCtx.arc(point.x * overlay.width, point.y * overlay.height, 4, 0, Math.PI * 2);
        overlayCtx.fill();
      }
    }
    if (editing && draftPolygon) {
      drawPolygon(overlayCtx, draftPolygon, 'rgb(250,204,21)', 2.5, draftPolygon.length >= 3 ? 0.2 : 0);
      overlayCtx.fillStyle = 'rgb(250,204,21)';
      for (const point of draftPolygon) {
        overlayCtx.beginPath();
        overlayCtx.arc(point.x * overlay.width, point.y * overlay.height, 6, 0, Math.PI * 2);
        overlayCtx.fill();
      }
    }
  }, [draftPolygon, editing, frame, polygon]);

  const pointFromEvent = useMemo(() => (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  }, []);

  const hitVertex = (point: { x: number; y: number }, candidates: Polygon | null): number | null => {
    if (!candidates) return null;
    const canvas = overlayRef.current;
    if (!canvas) return null;
    const thresholdX = 10 / canvas.getBoundingClientRect().width;
    const thresholdY = 10 / canvas.getBoundingClientRect().height;
    for (let i = 0; i < candidates.length; i += 1) {
      if (Math.abs(candidates[i].x - point.x) <= thresholdX && Math.abs(candidates[i].y - point.y) <= thresholdY) return i;
    }
    return null;
  };

  const hitEdge = (point: { x: number; y: number }, candidates: Polygon): number | null => {
    if (candidates.length < 3) return null;
    for (let i = 0; i < candidates.length; i += 1) {
      const a = candidates[i];
      const b = candidates[(i + 1) % candidates.length];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lengthSquared = abx * abx + aby * aby;
      const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((point.x - a.x) * abx + (point.y - a.y) * aby) / lengthSquared));
      const qx = a.x + abx * t;
      const qy = a.y + aby * t;
      if (Math.hypot(qx - point.x, qy - point.y) < 12 / (overlayRef.current?.getBoundingClientRect().width ?? 1)) return i;
    }
    return null;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing || !draftPolygon) return;
    const point = pointFromEvent(event);
    const hit = hitVertex(point, draftPolygon);
    if (hit !== null) {
      setDragIndex(hit);
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (draftPolygon.length < 3) {
      onChangeDraft([...draftPolygon, point]);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing || dragIndex === null || !draftPolygon) return;
    const point = pointFromEvent(event);
    const next = draftPolygon.map((item, index) => (index === dragIndex ? point : item));
    onChangeDraft(next);
  };

  const stopDrag = () => setDragIndex(null);

  const onDoubleClick = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing || !draftPolygon || draftPolygon.length < 3) return;
    const point = pointFromEvent(event);
    const vertex = hitVertex(point, draftPolygon);
    if (vertex !== null && draftPolygon.length > 3) {
      onChangeDraft(draftPolygon.filter((_, index) => index !== vertex));
      return;
    }
    const edge = hitEdge(point, draftPolygon);
    if (edge !== null) {
      const next = [...draftPolygon];
      next.splice(edge + 1, 0, point);
      onChangeDraft(next);
    }
  };

  return (
    <div className="canvas-wrap">
      <div className="canvas-inner">
        <canvas ref={videoRef} className="video-canvas" />
        <canvas
          ref={overlayRef}
          className="overlay-canvas"
          style={{ pointerEvents: editing ? 'auto' : 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onDoubleClick={onDoubleClick}
        />
      </div>
    </div>
  );
}
