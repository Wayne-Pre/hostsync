import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { AppError } from './errors.ts';
import type { MailTransport } from './mail.ts';
import { defaultTransport } from './mail.ts';
import { registerApi } from './api.ts';
import type { FetchLike } from './ics/sync.ts';
import {
  authenticate,
  completeOnboarding,
  registerUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  toPublicUser,
  verifyEmail,
} from './auth/accounts.ts';
import { createSession, findSession, revokeSession, SESSION_TTL_DAYS } from './auth/sessions.ts';
import type { AuthenticatedSession } from './auth/sessions.ts';
import { sendAsset, sendShell } from './web.ts';

export const SESSION_COOKIE = 'hs_session';
const SESSION_MAX_AGE_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

/** Screens anyone may load. */
export const PUBLIC_PAGES = [
  '/login',
  '/register',
  '/verify',
  '/forgot-password',
  '/reset-password',
] as const;

/**
 * Screens behind the session guard — the ten sidebar destinations of F-11.
 * `/dashboard` is "Overview".
 */
export const APP_PAGES = [
  '/dashboard',
  '/calendar',
  '/bookings',
  '/properties',
  '/operations',
  '/inbox',
  '/reviews',
  '/financials',
  '/payouts',
  '/settings',
] as const;

export interface BuildAppOptions {
  mailer?: MailTransport;
  logger?: boolean;
  /** injected in tests so a sync never opens a socket */
  fetchImpl?: FetchLike;
}

function body(request: FastifyRequest): Record<string, unknown> {
  const value = request.body;
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: process.env.NODE_ENV === 'production',
  });
}

async function currentSession(request: FastifyRequest): Promise<AuthenticatedSession | null> {
  const token = request.cookies[SESSION_COOKIE];
  return token ? findSession(token) : null;
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthenticatedSession | null> {
  const session = await currentSession(request);
  if (!session) {
    reply.code(401).send({ error: 'not_authenticated', message: 'sign in to continue' });
    return null;
  }
  return session;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const mailer = options.mailer ?? defaultTransport;
  const app = Fastify({ logger: options.logger ?? false });

  app.register(cookie);

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AppError) {
      reply.code(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.field === undefined ? {} : { field: error.field }),
      });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      reply.code(status).send({ error: 'bad_request', message: (error as Error).message });
      return;
    }
    console.error(error);
    reply.code(500).send({ error: 'internal', message: 'something went wrong on our side' });
  });

  // ---- F-05 register -------------------------------------------------------
  app.post('/auth/register', async (request, reply) => {
    const input = body(request);
    const result = await registerUser(
      {
        email: String(input.email ?? ''),
        password: String(input.password ?? ''),
        displayName: typeof input.displayName === 'string' ? input.displayName : null,
      },
      mailer
    );
    reply.code(201).send({
      user: result.user,
      otpSent: true,
      next: 'verify_email',
    });
  });

  // ---- F-06 OTP ------------------------------------------------------------
  app.post('/auth/verify', async (request, reply) => {
    const input = body(request);
    const user = await verifyEmail(input.email, input.code);
    const session = await createSession(user.id, request.headers['user-agent']);
    setSessionCookie(reply, session.token);
    reply.code(200).send({ user });
  });

  app.post('/auth/verify/resend', async (request, reply) => {
    const input = body(request);
    await resendVerification(input.email, mailer);
    reply.code(202).send({ sent: true });
  });

  // ---- F-07 login ----------------------------------------------------------
  app.post('/auth/login', async (request, reply) => {
    const input = body(request);
    const user = await authenticate(input.email, input.password);
    const session = await createSession(user.id, request.headers['user-agent']);
    setSessionCookie(reply, session.token);
    reply.code(200).send({ user: toPublicUser(user) });
  });

  app.get('/auth/me', async (request, reply) => {
    const session = await currentSession(request);
    if (!session) {
      reply.code(401).send({ error: 'not_authenticated', message: 'sign in to continue' });
      return;
    }
    reply.code(200).send({ user: session.user });
  });

  // ---- F-09 logout ---------------------------------------------------------
  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.code(204).send();
  });

  // ---- F-08 password reset -------------------------------------------------
  app.post('/auth/password/forgot', async (request, reply) => {
    const input = body(request);
    await requestPasswordReset(input.email, mailer);
    // Same answer for a known and an unknown address.
    reply.code(202).send({ sent: true });
  });

  app.post('/auth/password/reset', async (request, reply) => {
    const input = body(request);
    await resetPassword(input.token, input.password);
    reply.code(204).send();
  });

  // ---- F-10 onboarding -----------------------------------------------------
  app.post('/onboarding', async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const input = body(request);
    const result = await completeOnboarding(session.user.id, {
      portfolioName: String(input.portfolioName ?? ''),
      displayName: typeof input.displayName === 'string' ? input.displayName : null,
      currency: typeof input.currency === 'string' ? input.currency : undefined,
    });
    reply.code(200).send(result);
  });

  // ---- Stage 1 data API ----------------------------------------------------
  app.register(async (instance) =>
    registerApi(instance, { fetchImpl: options.fetchImpl, mailer })
  );

  // ---- F-01 public pages ---------------------------------------------------
  // Every screen is rendered by the same React bundle; the server's job is to
  // decide *whether* a visitor may have the shell at all.
  app.get('/', async (_request, reply) => {
    sendShell(reply);
  });

  for (const path of PUBLIC_PAGES) {
    app.get(path, async (_request, reply) => {
      sendShell(reply);
    });
  }

  // ---- F-09 session guard --------------------------------------------------
  // A signed-out visitor never receives the app shell: the redirect happens at
  // the HTTP layer, before any personal data is rendered.
  for (const path of APP_PAGES) {
    app.get(path, async (request, reply) => {
      const session = await currentSession(request);
      if (!session) {
        reply.code(302).header('location', '/login').send();
        return;
      }
      sendShell(reply);
    });
  }

  // ---- built assets --------------------------------------------------------
  app.get('/assets/*', async (request, reply) => {
    if (!sendAsset(request.url, reply)) {
      reply.code(404).send({ error: 'not_found', message: 'no such asset' });
    }
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: 'not_found', message: 'no such route' });
  });

  return app;
}
