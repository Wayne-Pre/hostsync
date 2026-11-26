/**
 * F-76 / F-77 — the team roster.
 *
 * A paused member is not deleted: the history of who did which turnover still
 * has to read correctly. Pausing only removes somebody from the pickers.
 */
import { query, queryOne, withTransaction } from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import { assertPasswordAcceptable, hashPassword } from './auth/passwords.ts';
import { revokeAllSessions } from './auth/sessions.ts';
import { normalizeEmail } from './auth/tokens.ts';

export const TEAM_ROLES = [
  'owner',
  'manager',
  'front_desk',
  'cleaner',
  'maintenance',
  'inspector',
] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

export interface TeamMember {
  id: string;
  portfolioId: string;
  name: string;
  role: TeamRole;
  phone: string | null;
  hourlyRateCents: number;
  reliabilityPct: number;
  active: boolean;
  /** True once this member has been given a phone login. */
  hasAccount: boolean;
  /** The address they sign in with; null until an account exists. */
  loginEmail: string | null;
}

interface MemberRow {
  id: string;
  portfolio_id: string;
  name: string;
  role: TeamRole;
  phone: string | null;
  hourly_rate_cents: string | number;
  reliability_pct: number;
  active: boolean;
  user_id?: string | null;
  email?: string | null;
}

function mapMember(row: MemberRow): TeamMember {
  return {
    id: row.id,
    portfolioId: row.portfolio_id,
    name: row.name,
    role: row.role,
    phone: row.phone,
    hourlyRateCents: Number(row.hourly_rate_cents),
    reliabilityPct: Number(row.reliability_pct),
    active: row.active,
    hasAccount: Boolean(row.user_id),
    loginEmail: row.email ?? null,
  };
}

/** The roster plus the login that belongs to each member, if any. */
const MEMBER_COLUMNS = `m.id, m.portfolio_id, m.name, m.role, m.phone,
     m.hourly_rate_cents, m.reliability_pct, m.active, m.user_id, u.email`;

const MEMBER_FROM = `from team_member m left join app_user u on u.id = m.user_id`;

export async function listTeam(portfolioId: string): Promise<TeamMember[]> {
  const rows = await query<MemberRow>(
    `select ${MEMBER_COLUMNS} ${MEMBER_FROM}
      where m.portfolio_id = $1 order by m.name`,
    [portfolioId]
  );
  return rows.map(mapMember);
}

/** Only the members who can be handed work right now. */
export async function listAssignableTeam(portfolioId: string): Promise<TeamMember[]> {
  const rows = await query<MemberRow>(
    `select ${MEMBER_COLUMNS} ${MEMBER_FROM}
      where m.portfolio_id = $1 and m.active order by m.name`,
    [portfolioId]
  );
  return rows.map(mapMember);
}

async function loadMember(memberId: string): Promise<TeamMember | null> {
  const row = await queryOne<MemberRow>(
    `select ${MEMBER_COLUMNS} ${MEMBER_FROM} where m.id = $1`,
    [memberId]
  );
  return row ? mapMember(row) : null;
}

export interface AddMemberInput {
  portfolioId: string;
  name: string;
  role: string;
  phone: string | null;
  hourlyRateCents: number;
  reliabilityPct: number;
}

export async function addMember(input: AddMemberInput): Promise<TeamMember> {
  const name = input.name.trim();
  if (!name) throw new ValidationError('a team member needs a name', 'name');

  const role = input.role as TeamRole;
  if (!TEAM_ROLES.includes(role)) {
    throw new ValidationError(`role must be one of: ${TEAM_ROLES.join(', ')}`, 'role');
  }

  if (input.phone) {
    const existing = await queryOne<{ id: string }>(
      'select id from team_member where portfolio_id = $1 and phone = $2',
      [input.portfolioId, input.phone]
    );
    if (existing) throw new ConflictError('that phone number is already on the roster');
  }

  const row = await queryOne<MemberRow>(
    `insert into team_member (
       portfolio_id, name, role, phone, hourly_rate_cents, reliability_pct
     ) values ($1, $2, $3, $4, $5, $6)
     returning id, portfolio_id, name, role, phone, hourly_rate_cents, reliability_pct, active`,
    [
      input.portfolioId,
      name,
      role,
      input.phone,
      Math.max(0, Math.round(input.hourlyRateCents)),
      Math.min(100, Math.max(0, Math.round(input.reliabilityPct))),
    ]
  );
  if (!row) throw new Error('team member insert returned no row');
  return mapMember(row);
}

/** The roster row tied to a cleaner login: its name is the task assignee. */
export interface WorkerMembership {
  portfolioId: string;
  name: string;
}

export async function findWorkerMembership(
  userId: string
): Promise<WorkerMembership | null> {
  return queryOne<WorkerMembership>(
    `select portfolio_id as "portfolioId", name
       from team_member where user_id = $1`,
    [userId]
  );
}

/** Give an existing roster member their own login for the field screen. */
export async function createWorkerAccount(input: {
  memberId: string;
  portfolioId: string;
  email: string;
  password: string;
}): Promise<TeamMember> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new ValidationError('email is not a valid address', 'email');
  }
  const password = assertPasswordAcceptable(input.password);
  const hash = await hashPassword(password);

  await withTransaction(async (client) => {
    const member = await client.query<MemberRow>(
      `select id, portfolio_id, name, role, phone, hourly_rate_cents, reliability_pct, active
         from team_member where id = $1 and portfolio_id = $2`,
      [input.memberId, input.portfolioId]
    );
    const existingMember = member.rows[0];
    if (!existingMember) throw new NotFoundError('team member');

    const duplicate = await client.query<{ id: string }>(
      'select id from app_user where lower(email) = lower($1)',
      [email]
    );
    if (duplicate.rows[0]) throw new ConflictError('that email is already in use');

    const created = await client.query<{ id: string }>(
      `insert into app_user (email, password_hash, display_name, is_verified,
                             onboarding_complete, account_role)
       values ($1, $2, $3, true, true, 'cleaner')
       returning id`,
      [email, hash, existingMember.name]
    );
    const userId = created.rows[0]?.id;
    if (!userId) throw new Error('worker account insert returned no row');

    await client.query(
      `update team_member set user_id = $2, updated_at = now() where id = $1`,
      [input.memberId, userId]
    );
  });
  const member = await loadMember(input.memberId);
  if (!member) throw new NotFoundError('team member');
  return member;
}

/** A manager issues a new password; every old session for that worker dies. */
export async function resetWorkerPassword(input: {
  memberId: string;
  portfolioId: string;
  password: string;
}): Promise<TeamMember> {
  const password = assertPasswordAcceptable(input.password);
  const hash = await hashPassword(password);

  const row = await queryOne<{ user_id: string | null }>(
    'select user_id from team_member where id = $1 and portfolio_id = $2',
    [input.memberId, input.portfolioId]
  );
  if (!row) throw new NotFoundError('team member');
  if (!row.user_id) throw new ValidationError('this member has no login yet', 'memberId');

  await query('update app_user set password_hash = $2, force_password_reset = false where id = $1', [
    row.user_id,
    hash,
  ]);
  await revokeAllSessions(row.user_id);

  const member = await loadMember(input.memberId);
  if (!member) throw new NotFoundError('team member');
  return member;
}

/** Pausing keeps the record and clears the member from the assignment pickers. */
export async function setMemberActive(
  memberId: string,
  portfolioId: string,
  active: boolean
): Promise<TeamMember> {
  const row = await queryOne<{ id: string }>(
    `update team_member
        set active = $3, updated_at = now()
      where id = $1 and portfolio_id = $2
      returning id`,
    [memberId, portfolioId, active]
  );
  if (!row) throw new NotFoundError('team member');
  const member = await loadMember(memberId);
  if (!member) throw new NotFoundError('team member');
  return member;
}
