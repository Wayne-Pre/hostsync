import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { getJson, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * Team & access — the roster plus the phone login each field worker signs in
 * with.
 *
 * The cleaner never signs up. The company owns the account: a manager adds the
 * person to the roster, sets the email and password, and hands those details
 * over. That is the same model as a construction agency handing a site worker
 * their login, and it means the login can be reset or switched off from here.
 */

interface Member {
  id: string;
  name: string;
  role: string;
  phone: string | null;
  hourlyRateCents: number;
  active: boolean;
  hasAccount: boolean;
  loginEmail: string | null;
}

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'cleaner', label: 'Cleaner' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'inspector', label: 'Inspector' },
  { value: 'front_desk', label: 'Front desk' },
  { value: 'manager', label: 'Manager' },
];

const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  ROLES.map((role) => [role.value, role.label])
);

const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A password a person can read off a phone screen without mistakes. */
function suggestPassword(): string {
  const bytes = new Uint32Array(10);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (value) => ALPHABET[value % ALPHABET.length]).join('');
  return `${body.slice(0, 5)}-${body.slice(5)}`;
}

function suggestEmail(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return slug ? `${slug}@` : '';
}

function money(cents: number): string {
  return `KSh ${(cents / 100).toFixed(0)}/hr`;
}

interface Credentials {
  name: string;
  email: string;
  password: string;
  mode: 'created' | 'reset';
}

export function TeamScreen() {
  const toast = useToast();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    name: '',
    role: 'cleaner',
    phone: '',
    hourlyRate: '450',
  });

  const [accessMember, setAccessMember] = useState<Member | null>(null);
  const [accessMode, setAccessMode] = useState<'create' | 'reset'>('create');
  const [accessForm, setAccessForm] = useState({ email: '', password: '' });
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await getJson<{ members: Member[] }>('/api/team');
      setMembers(result.members);
      setError(null);
    } catch {
      setError('Could not load the team roster.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addMember(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await sendJson('POST', '/api/team', {
        name: addForm.name,
        role: addForm.role,
        phone: addForm.phone || null,
        hourlyRateCents: Math.round(Number(addForm.hourlyRate || 0) * 100),
      });
      toast(`${addForm.name.trim()} added to the roster`);
      setAddOpen(false);
      setAddForm({ name: '', role: 'cleaner', phone: '', hourlyRate: '450' });
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not add that person', 'error');
    } finally {
      setBusy(false);
    }
  }

  function openAccess(member: Member, mode: 'create' | 'reset') {
    setAccessMember(member);
    setAccessMode(mode);
    setAccessForm({
      email: mode === 'create' ? suggestEmail(member.name) : (member.loginEmail ?? ''),
      password: suggestPassword(),
    });
  }

  async function saveAccess(event: FormEvent) {
    event.preventDefault();
    if (!accessMember) return;
    setBusy(true);
    try {
      const url =
        accessMode === 'create'
          ? `/api/team/${accessMember.id}/worker-account`
          : `/api/team/${accessMember.id}/worker-password`;
      await sendJson('POST', url, accessForm);
      setCredentials({
        name: accessMember.name,
        email: accessForm.email.trim().toLowerCase(),
        password: accessForm.password,
        mode: accessMode === 'create' ? 'created' : 'reset',
      });
      setAccessMember(null);
      await load();
      toast(accessMode === 'create' ? 'Phone login created' : 'Password changed');
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save those details', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(member: Member) {
    setBusy(true);
    try {
      await sendJson('POST', `/api/team/${member.id}/${member.active ? 'pause' : 'resume'}`);
      toast(member.active ? `${member.name} paused` : `${member.name} is back on the roster`);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not change that person', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(entry: Credentials) {
    const text = [
      `Hi ${entry.name.split(' ')[0]}, your HostSync jobs login is ready.`,
      '',
      `Open: ${window.location.origin}/login`,
      `Email: ${entry.email}`,
      `Password: ${entry.password}`,
      '',
      'Your jobs are under "My jobs" after you sign in.',
      'On your phone: browser menu → Add to Home screen, so it opens like an app.',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Message copied — send it on WhatsApp or SMS');
    } catch {
      toast('Could not copy; select the details and copy them by hand', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!members) return <p className="loading">Loading the roster…</p>;

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="how-title">
        <header className="panel-head">
          <h2 id="how-title">How a cleaner gets access</h2>
          <p>The company owns the login. Nobody signs themselves up.</p>
        </header>
        <ol className="access-steps">
          <li>
            <span className="access-num">1</span>
            <div>
              <strong>Add them to the roster</strong>
              <p>Name, role (cleaner) and phone. They now appear in the assignee picker.</p>
            </div>
          </li>
          <li>
            <span className="access-num">2</span>
            <div>
              <strong>Give phone access</strong>
              <p>You choose the email and password. We show you a ready-to-send message.</p>
            </div>
          </li>
          <li>
            <span className="access-num">3</span>
            <div>
              <strong>They open “My jobs”</strong>
              <p>
                Only their own jobs, checklist, proof photos and Done — nothing about money or other
                properties.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <section className="panel" aria-labelledby="roster-title">
        <header className="panel-head panel-head-row">
          <div>
            <h2 id="roster-title">Roster</h2>
            <p>{members.length} people · phone access is granted per person.</p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            data-testid="add-member-button"
            onClick={() => setAddOpen(true)}
          >
            + Add person
          </button>
        </header>

        <ul className="roster" data-testid="team-roster">
          {members.map((member) => (
            <li className={`roster-row${member.active ? '' : ' is-paused'}`} key={member.id}>
              <span className="roster-avatar" aria-hidden="true">
                {member.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="roster-who">
                <strong>{member.name}</strong>
                <small>
                  {ROLE_LABEL[member.role] ?? member.role}
                  {member.phone ? ` · ${member.phone}` : ''} · {money(member.hourlyRateCents)}
                </small>
                {member.hasAccount ? (
                  <span className="access-badge is-on" data-testid="access-on">
                    Phone access · {member.loginEmail}
                  </span>
                ) : (
                  <span className="access-badge" data-testid="access-off">
                    No phone access yet
                  </span>
                )}
              </div>
              <div className="roster-actions">
                {member.hasAccount ? (
                  <button
                    type="button"
                    className="btn"
                    data-testid="reset-password"
                    disabled={busy}
                    onClick={() => openAccess(member, 'reset')}
                  >
                    New password
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="give-access"
                    disabled={busy}
                    onClick={() => openAccess(member, 'create')}
                  >
                    Give access
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-testid="pause-member"
                  disabled={busy}
                  onClick={() => void toggleActive(member)}
                >
                  {member.active ? 'Pause' : 'Resume'}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {members.length === 0 ? <p className="muted">Nobody on the roster yet.</p> : null}
      </section>

      {credentials ? (
        <>
          <div className="sheet-overlay" onClick={() => setCredentials(null)} />
          <div
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="creds-title"
            data-testid="credentials"
          >
            <div className="dialog-head">
              <h2 className="dialog-title" id="creds-title">
                {credentials.mode === 'created' ? 'Login created' : 'Password changed'}
              </h2>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Close"
                onClick={() => setCredentials(null)}
              >
                ✕
              </button>
            </div>
            <div className="dialog-form">
              <p className="muted">
                Send these to {credentials.name}. Only they can use them, and you can change the
                password here at any time.
              </p>
              <div className="creds">
                <div>
                  <span>Sign-in page</span>
                  <code>{window.location.origin}/login</code>
                </div>
                <div>
                  <span>Email</span>
                  <code>{credentials.email}</code>
                </div>
                <div>
                  <span>Password</span>
                  <code>{credentials.password}</code>
                </div>
              </div>
              <div className="dialog-actions">
                <button type="button" className="btn btn-primary" onClick={() => void copyInvite(credentials)}>
                  Copy message for WhatsApp
                </button>
                <button type="button" className="btn" onClick={() => setCredentials(null)}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </>
      ) : null}

      {accessMember ? (
        <>
          <div className="sheet-overlay" onClick={() => setAccessMember(null)} />
          <div
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="access-title"
          >
            <div className="dialog-head">
              <h2 className="dialog-title" id="access-title">
                {accessMode === 'create'
                  ? `Give ${accessMember.name} phone access`
                  : `New password for ${accessMember.name}`}
              </h2>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Close"
                onClick={() => setAccessMember(null)}
              >
                ✕
              </button>
            </div>
            <form className="dialog-form" onSubmit={(event) => void saveAccess(event)}>
              <div className="field">
                <label htmlFor="worker-email">Email they sign in with</label>
                <input
                  id="worker-email"
                  data-testid="worker-email"
                  type="email"
                  required
                  autoComplete="off"
                  value={accessForm.email}
                  onChange={(event) => setAccessForm({ ...accessForm, email: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="worker-password">Password</label>
                <input
                  id="worker-password"
                  data-testid="worker-password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={accessForm.password}
                  onChange={(event) =>
                    setAccessForm({ ...accessForm, password: event.target.value })
                  }
                />
                <p className="field-hint">
                  Suggested and easy to read out. They can change it later; you can reset it here.
                </p>
              </div>
              <div className="dialog-actions">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {accessMode === 'create' ? 'Create login' : 'Save password'}
                </button>
                <button type="button" className="btn" onClick={() => setAccessMember(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}

      {addOpen ? (
        <>
          <div className="sheet-overlay" onClick={() => setAddOpen(false)} />
          <div className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="add-title">
            <div className="dialog-head">
              <h2 className="dialog-title" id="add-title">
                Add a person
              </h2>
              <button
                type="button"
                className="btn btn-ghost"
                aria-label="Close"
                onClick={() => setAddOpen(false)}
              >
                ✕
              </button>
            </div>
            <form className="dialog-form" onSubmit={(event) => void addMember(event)}>
              <div className="field">
                <label htmlFor="member-name">Full name</label>
                <input
                  id="member-name"
                  data-testid="member-name"
                  required
                  value={addForm.name}
                  onChange={(event) => setAddForm({ ...addForm, name: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="member-role">Role</label>
                <select
                  id="member-role"
                  value={addForm.role}
                  onChange={(event) => setAddForm({ ...addForm, role: event.target.value })}
                >
                  {ROLES.map((role) => (
                    <option key={role.value} value={role.value}>
                      {role.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="member-phone">Phone (optional)</label>
                <input
                  id="member-phone"
                  value={addForm.phone}
                  onChange={(event) => setAddForm({ ...addForm, phone: event.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="member-rate">Hourly rate (KSh)</label>
                <input
                  id="member-rate"
                  inputMode="numeric"
                  value={addForm.hourlyRate}
                  onChange={(event) => setAddForm({ ...addForm, hourlyRate: event.target.value })}
                />
              </div>
              <div className="dialog-actions">
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  Add to roster
                </button>
                <button type="button" className="btn" onClick={() => setAddOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
}
