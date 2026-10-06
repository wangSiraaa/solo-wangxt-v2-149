import type { FrameGeometry } from '../types';
import { displaySize } from './geometry';

export function configureDisplayCanvas(canvas: HTMLCanvasElement, geometry: FrameGeometry): { width: number; height: number } {
  const size = displaySize(geometry);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height };
}

export function drawFrameToDisplayCanvas(
  ctx: CanvasRenderingContext2D,
  frame: VideoFrame,
  geometry: FrameGeometry
): void {
  const { width, height } = configureDisplayCanvas(ctx.canvas, geometry);
  const par = geometry.pixelAspectWidth / geometry.pixelAspectHeight;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // The decoded VideoFrame is always in coded-buffer coordinates. Apply PAR first in
  // coded space, then the container rotation, so tracking and edits use square display pixels.
  const scaleX = width / displaySize(geometry).width;
  const scaleY = height / displaySize(geometry).height;
  ctx.save();
  ctx.scale(scaleX, scaleY);
  const squareWidth = geometry.codedWidth * par;
  switch (geometry.rotationDegrees) {
    case 90:
      ctx.translate(geometry.codedHeight, 0);
      ctx.rotate(Math.PI / 2);
      ctx.scale(par, 1);
      break;
    case 180:
      ctx.translate(squareWidth, geometry.codedHeight);
      ctx.rotate(Math.PI);
      ctx.scale(par, 1);
      break;
    case 270:
      ctx.translate(0, squareWidth);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(par, 1);
      break;
    default:
      ctx.scale(par, 1);
  }
  ctx.drawImage(frame, 0, 0);
  ctx.restore();
}

export function frameToDisplayCanvas(frame: VideoFrame, geometry: FrameGeometry): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  drawFrameToDisplayCanvas(ctx, frame, geometry);
  return canvas;
}
