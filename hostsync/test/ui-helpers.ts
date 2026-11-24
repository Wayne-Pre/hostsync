/**
 * Shared harness for the E-level tests (T-01…T-04, T-09, T-11…T-13, T-38, T-42).
 *
 * Two deliberate choices:
 *  - the app listens on a real port, because a browser needs a URL;
 *  - Playwright drives the Chrome that is already installed (`channel: 'chrome'`)
 *    instead of downloading a second browser. This machine has 3.4 GB of RAM and
 *    a browser download plus a bundled Chromium is neither needed nor helpful.
 */
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createCaptureTransport } from '../src/mail.ts';
import type { ApiUser } from './api-helpers.ts';
import { signUp } from './api-helpers.ts';

export interface UiHarness {
  app: FastifyInstance;
  browser: Browser;
  baseUrl: string;
  /** A fresh, isolated browser context — cookies never leak between tests. */
  context(): Promise<BrowserContext>;
  /**
   * A page already signed in as `user`.
   *
   * The page is reused across the tests of one file: every document load on this
   * box costs 15–40 s, and a warm tab is the difference between a suite that
   * finishes and one that does not.
   */
  signedIn(user: ApiUser): Promise<Page>;
  close(): Promise<void>;
}

export const mailer = createCaptureTransport();

export async function startUi(): Promise<UiHarness> {
  const app = buildApp({ mailer });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('the test server did not bind a port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-back-forward-cache',
      '--disable-features=Translate,CalculateNativeWinOcclusion',
      '--no-first-run',
      // This box has ~0.4 GB free. Chrome's defaults spawn a renderer per tab
      // with a 512 MB heap ceiling, which is more than the whole machine has
      // spare — and a starved Postgres cannot even fork a connection.
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=128',
    ],
  });

  // Warm the browser once, before any test asserts anything. On this machine a
  // cold Chrome + first-time bundle compile can take longer than a fair timeout,
  // and a timeout here would look like a product failure when it is not one.
  const warm = await browser.newContext({ baseURL: baseUrl });
  const warmPage = await warm.newPage();
  await warmPage.goto('/', { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await warmPage.waitForSelector('h1', { timeout: 60_000 });
  await warm.close();

  const pages = new Map<string, Page>();

  return {
    app,
    browser,
    baseUrl,
    async context() {
      const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
      // This box has 3.4 GB of RAM: a full document load plus React mount takes
      // a few seconds, so the defaults (15 s / 30 s) are too tight to be a fair
      // signal about the app's own correctness.
      context.setDefaultTimeout(60_000);
      context.setDefaultNavigationTimeout(120_000);
      return context;
    },
    async signedIn(user: ApiUser) {
      const existing = pages.get(user.userId);
      if (existing && !existing.isClosed()) return existing;

      const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } });
      context.setDefaultTimeout(60_000);
      context.setDefaultNavigationTimeout(120_000);
      const [name, value] = user.cookie.split('=');
      if (!name || !value) throw new Error(`unexpected cookie shape: ${user.cookie}`);
      await context.addCookies([{ name, value, url: baseUrl }]);
      const page = await context.newPage();
      pages.set(user.userId, page);
      return page;
    },
    async close() {
      for (const page of pages.values()) {
        if (!page.isClosed()) await page.context().close();
      }
      pages.clear();
      await browser.close();
      await app.close();
    },
  };
}

export async function newUser(app: FastifyInstance, portfolioName = 'TEST'): Promise<ApiUser> {
  return signUp(app, mailer, portfolioName);
}

/** Every request the page made, so a test can assert what was *not* fetched. */
export function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}
