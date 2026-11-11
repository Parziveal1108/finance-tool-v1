import type { Response } from 'express';

/** Server-sent events: pushes "something changed" to every open tab and phone. */
const clients = new Set<Response>();

export function subscribe(res: Response) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function emit(type: 'state' | 'insight' | 'sync', data: unknown = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}

setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 25000).unref();
