import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Runs the assistant against a local stand-in for the Anthropic Messages API. This checks
 * our side of the conversation — the streaming loop, tool execution, persistence — with the
 * real SDK. It cannot check that the live API accepts every request field.
 */

interface Recorded {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

const requests: Recorded[] = [];
let script: ((body: any) => any[])[] = [];
let server: http.Server;

const usage = { input_tokens: 10, output_tokens: 5 };
const message = (content: any[], stop_reason: string) => ({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage });

function sse(res: http.ServerResponse, content: any[], stop_reason: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: message([], null as unknown as string) });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const piece of block.text.match(/.{1,12}/gs) ?? []) send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      const json = JSON.stringify(block.input);
      for (const piece of json.match(/.{1,20}/gs) ?? []) send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', {});
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const next = script.shift();
      if (!next) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'unexpected request' } }));
      }
      const content = next(body);
      const stop = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
      if (body.stream) return sse(res, content, stop);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(message(content, stop)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.KEEL_DB = ':memory:';
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('assistant', () => {
  it('records what the user describes, streams the reply and stores the conversation', async () => {
    const { chat } = await import('../server/lib/agent');
    const { q } = await import('../server/db');
    requests.length = 0;
    script = [
      () => [
        { type: 'text', text: 'Saving that now.' },
        { type: 'tool_use', id: 'toolu_1', name: 'save_accounts', input: { accounts: [{ name: 'Travel Visa', type: 'credit', balance: 4200, apr: 24.99, min_payment: 95 }] } },
      ],
      () => [{ type: 'text', text: 'Saved your **Travel Visa**: $4,200 at 24.99% APR.' }],
    ];
    const events: any[] = [];
    await chat('I have a Visa with $4,200 at 24.99% APR, minimum $95', [], (e) => events.push(e));

    // The account exists with the details from the tool call.
    const account = q.get<any>("SELECT * FROM accounts WHERE name = 'Travel Visa'");
    expect(account).toMatchObject({ type: 'credit', balance: 4200, apr: 24.99, min_payment: 95, source: 'assistant' });

    // The UI saw tool activity, streamed text from both turns, and a final "changed" signal.
    expect(events.find((e) => e.type === 'tool')).toEqual({ type: 'tool', name: 'Saving accounts' });
    const text = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    expect(text).toBe('Saving that now.\n\nSaved your **Travel Visa**: $4,200 at 24.99% APR.');
    expect(events.at(-1)).toEqual({ type: 'done', changed: true });

    // Both sides are stored for the next turn.
    const stored = q.all<any>('SELECT role, text FROM chat ORDER BY id');
    expect(stored.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(stored[1].text).toContain('Saved your **Travel Visa**');

    // Request shape: model, cached system prompt, tools, effort; tool result fed back on turn two.
    const [first, second] = requests;
    expect(first.path).toContain('/v1/messages');
    expect(first.body.model).toBe('claude-opus-5-5');
    expect(first.body.stream).toBe(true);
    expect(first.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(first.body.output_config).toEqual({ effort: 'medium' });
    expect(first.body.fallbacks).toBe('default');
    expect(String(first.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(first.body.tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(['get_financial_overview', 'save_accounts', 'add_transactions', 'simulate_debt_payoff', 'create_suggestion']));
    expect(first.body.tools.every((t: any) => t.input_schema?.type === 'object')).toBe(true);
    const result = second.body.messages.at(-1).content.find((b: any) => b.type === 'tool_result');
    expect(result.tool_use_id).toBe('toolu_1');
    expect(JSON.stringify(result.content)).toContain('Travel Visa');
  });

  it('rejects malformed tool input instead of writing it', async () => {
    const { chat } = await import('../server/lib/agent');
    const { q } = await import('../server/db');
    requests.length = 0;
    script = [
      () => [{ type: 'tool_use', id: 'toolu_2', name: 'save_accounts', input: { accounts: [{ name: 'Broken', type: 'spaceship', balance: 'lots' }] } }],
      () => [{ type: 'text', text: 'That did not go through.' }],
    ];
    const events: any[] = [];
    await chat('add a broken account', [], (e) => events.push(e));
    expect(q.get("SELECT 1 FROM accounts WHERE name = 'Broken'")).toBeUndefined();
    const result = requests[1].body.messages.at(-1).content.find((b: any) => b.type === 'tool_result');
    expect(result.is_error).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', changed: false });
  });

  it('carries earlier turns into the next request', async () => {
    const { chat } = await import('../server/lib/agent');
    requests.length = 0;
    script = [() => [{ type: 'text', text: 'You owe $4,200.' }]];
    await chat('what do I owe?', [], () => undefined);
    const roles = requests[0].body.messages.map((m: any) => m.role);
    expect(roles.slice(0, 2)).toEqual(['user', 'assistant']);
    expect(roles.at(-1)).toBe('user');
    expect(JSON.stringify(requests[0].body.messages.at(-1).content)).toContain('what do I owe?');
  });

  it('reports API failures in plain words and keeps the conversation clean', async () => {
    const { chat } = await import('../server/lib/agent');
    const { q } = await import('../server/db');
    const before = q.get<{ n: number }>('SELECT COUNT(*) n FROM chat')!.n;
    script = []; // the stand-in answers 500 to anything unscripted
    const events: any[] = [];
    await chat('hello?', [], (e) => events.push(e));
    expect(events.at(-1).type).toBe('error');
    expect(events.at(-1).message).toMatch(/API error/);
    expect(q.get<{ n: number }>('SELECT COUNT(*) n FROM chat')!.n).toBe(before);
  }, 30_000);

  it('writes a briefing and files suggestions with one-tap actions', async () => {
    const { runBriefing } = await import('../server/lib/agent');
    const { q, getSetting } = await import('../server/db');
    requests.length = 0;
    script = [
      () => [{ type: 'tool_use', id: 'toolu_3', name: 'get_financial_overview', input: {} }],
      () => [
        {
          type: 'tool_use',
          id: 'toolu_4',
          name: 'create_suggestion',
          input: { title: 'Put $150 more toward Travel Visa', body: 'At 24.99% APR an extra $150 a month clears it about a year sooner.', area: 'debt', severity: 'info', action: { type: 'set_extra_payment', amount: 150, label: 'Set extra payment to $150/mo' } },
        },
      ],
      () => [{ type: 'text', text: 'Your Visa is the thing to watch this month.' }],
    ];
    const text = await runBriefing();
    expect(text).toBe('Your Visa is the thing to watch this month.');
    expect(getSetting<any>('brief', null)).toMatchObject({ text, source: 'assistant' });
    const row = q.get<any>("SELECT * FROM insights WHERE source = 'assistant'");
    expect(row.title).toBe('Put $150 more toward Travel Visa');
    expect(JSON.parse(row.action)).toEqual({ type: 'set_extra_payment', amount: 150, label: 'Set extra payment to $150/mo' });
    // The overview the model received reflects the account saved earlier.
    const overview = requests[1].body.messages.at(-1).content.find((b: any) => b.type === 'tool_result');
    expect(JSON.stringify(overview.content)).toContain('Travel Visa');
    expect(requests[0].body.stream).toBeFalsy();

    // Applying the suggestion changes the plan.
    const { applyAction } = await import('../server/lib/insights');
    const { getSettings } = await import('../server/db');
    applyAction(JSON.parse(row.action));
    expect(getSettings().extra_payment).toBe(150);
  });
});
