/**
 * F-76 / F-77 — the team roster.
 *
 * A paused member is not deleted: the history of who did which turnover still
 * has to read correctly. Pausing only removes somebody from the pickers.
 */
import { query, queryOne } from './db.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';

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
  };
}

export async function listTeam(portfolioId: string): Promise<TeamMember[]> {
  const rows = await query<MemberRow>(
    `select id, portfolio_id, name, role, phone, hourly_rate_cents, reliability_pct, active
       from team_member where portfolio_id = $1 order by name`,
    [portfolioId]
  );
  return rows.map(mapMember);
}

/** Only the members who can be handed work right now. */
export async function listAssignableTeam(portfolioId: string): Promise<TeamMember[]> {
  const rows = await query<MemberRow>(
    `select id, portfolio_id, name, role, phone, hourly_rate_cents, reliability_pct, active
       from team_member where portfolio_id = $1 and active order by name`,
    [portfolioId]
  );
  return rows.map(mapMember);
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

/** Pausing keeps the record and clears the member from the assignment pickers. */
export async function setMemberActive(
  memberId: string,
  portfolioId: string,
  active: boolean
): Promise<TeamMember> {
  const row = await queryOne<MemberRow>(
    `update team_member m
        set active = $3, updated_at = now()
       from portfolio p
      where m.id = $1 and m.portfolio_id = $2 and p.id = m.portfolio_id
      returning m.id, m.portfolio_id, m.name, m.role, m.phone,
                m.hourly_rate_cents, m.reliability_pct, m.active`,
    [memberId, portfolioId, active]
  );
  if (!row) throw new NotFoundError('team member');
  return mapMember(row);
}
