// Capture helpers for PNG/video export: container/codec choice and the drawn pointer.

/** Recorder format: H.264 (MPEG-4 Part 10) when requested and supported, otherwise VP9/VP8 WebM. */
export function videoFormat(h264: boolean, supported: (mime: string) => boolean): { mimeType: string; ext: 'mp4' | 'webm' } {
  const order: [string, 'mp4' | 'webm'][] = [
    ...(h264 ? [['video/mp4;codecs=avc1.640028', 'mp4'], ['video/mp4;codecs=avc1', 'mp4'], ['video/webm;codecs=h264', 'webm']] as [string, 'mp4' | 'webm'][] : []),
    ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm'],
  ];
  const hit = order.find(([m]) => supported(m)) ?? order[order.length - 1];
  return { mimeType: hit[0], ext: hit[1] };
}

/** Arrow pointer (white with a dark outline) at backbuffer position x, y; k = backbuffer px per CSS px. */
export function drawCursor(c: CanvasRenderingContext2D, x: number, y: number, k: number) {
  const p = [[0, 0], [0, 17], [4.5, 13], [7.5, 20], [10, 19], [7, 12], [12.5, 12]];
  c.save();
  c.translate(x, y); c.scale(k, k);
  c.beginPath();
  p.forEach(([px, py], i) => (i ? c.lineTo(px, py) : c.moveTo(px, py)));
  c.closePath();
  c.fillStyle = '#fff'; c.strokeStyle = '#000'; c.lineWidth = 1.2; c.lineJoin = 'round';
  c.fill(); c.stroke();
  c.restore();
}
