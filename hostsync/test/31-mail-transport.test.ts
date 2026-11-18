/** The production mail transport talks HTTPS because free hosts block SMTP. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createHttpTransport } from '../src/mail.ts';

const saved = {
  url: process.env.MAIL_API_URL,
  key: process.env.MAIL_API_KEY,
  from: process.env.MAIL_FROM,
};
let server: Server | null = null;

after(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

test('the HTTP transport posts the message with the API key', async () => {
  const received: Array<{ headers: Record<string, unknown>; body: unknown }> = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  process.env.MAIL_API_URL = `http://127.0.0.1:${address.port}/emails`;
  process.env.MAIL_API_KEY = 'test-key';
  process.env.MAIL_FROM = 'HostSync <test@example.test>';

  const transport = createHttpTransport();
  assert.equal(transport.kind, 'http');
  await transport.send({ to: 'guest@example.test', subject: 'Your code', text: '123456' });

  assert.equal(received.length, 1);
  assert.equal(received[0]!.headers.authorization, 'Bearer test-key');
  assert.deepEqual(received[0]!.body, {
    from: 'HostSync <test@example.test>',
    to: ['guest@example.test'],
    subject: 'Your code',
    text: '123456',
  });
});

test('the HTTP transport refuses to pretend it sent without a key', async () => {
  process.env.MAIL_API_KEY = '';
  await assert.rejects(
    createHttpTransport().send({ to: 'guest@example.test', subject: 's', text: 't' }),
    /MAIL_API_KEY is required/
  );
});
