import { useCallback, useEffect, useState } from 'react';
import { arrivalLabel, getJson, money, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-21 property cards · F-22 add property · F-23 edit property
 * F-24 status · F-25 calendar link · F-27 property account
 */

interface Card {
  id: string;
  name: string;
  status: string;
  type: string | null;
  neighbourhood: string | null;
  city: string | null;
  bedrooms: number | null;
  baths: number | null;
  guests: number | null;
  nightlyRateCents: number;
  cleaningFeeCents: number;
  managementFeeBps: number | null;
  ownerName: string | null;
  ownerEmail: string | null;
  photoKey: string | null;
  address: string | null;
  channels: string[];
  occupancyPct: number;
  nextArrival: string | null;
  account: { label: string; verified: boolean; balanceCents: number } | null;
}

interface Feed {
  id: string;
  url: string;
  source: string;
  lastSyncedAt: string | null;
  lastStatus: string | null;
}

const CHANNEL_BADGES = ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'];

const EMPTY_FORM = {
  name: '',
  status: 'onboarding',
  type: 'cottage',
  neighbourhood: '',
  city: 'Nairobi',
  address: '',
  bedrooms: '2',
  baths: '2',
  guests: '4',
  nightlyRate: '',
  cleaningFee: '',
  ownerName: '',
  ownerEmail: '',
  managementFeePercent: '18',
  channels: ['airbnb'] as string[],
  photoUrl: '',
};

export function Properties() {
  const toast = useToast();
  const [cards, setCards] = useState<Card[] | null>(null);
  const [currency, setCurrency] = useState('KES');
  const [editing, setEditing] = useState<Card | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [showForm, setShowForm] = useState(false);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [feedForm, setFeedForm] = useState({ url: '', source: 'airbnb' });
  const [accountForm, setAccountForm] = useState({ label: '', verified: false, balance: '' });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getJson<{ properties: Card[]; currency: string }>('/api/properties');
      setCards(data.properties);
      setCurrency(data.currency);
      setError(null);
    } catch {
      setError('Could not load the properties.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function startAdd() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setShowForm(true);
  }

  function startEdit(card: Card) {
    setEditing(card);
    setForm({
      name: card.name,
      status: card.status,
      type: card.type ?? 'cottage',
      neighbourhood: card.neighbourhood ?? '',
      city: card.city ?? '',
      address: '',
      bedrooms: String(card.bedrooms ?? ''),
      baths: String(card.baths ?? ''),
      guests: String(card.guests ?? ''),
      nightlyRate: String(card.nightlyRateCents / 100),
      cleaningFee: String(card.cleaningFeeCents / 100),
      ownerName: card.ownerName ?? '',
      ownerEmail: card.ownerEmail ?? '',
      managementFeePercent: String((card.managementFeeBps ?? 1800) / 100),
      channels: card.channels.length > 0 ? card.channels : ['airbnb'],
      photoUrl: card.photoKey ?? '',
    });
    setShowForm(true);
  }

  async function save() {
    const payload = {
      name: form.name,
      status: form.status,
      type: form.type,
      neighbourhood: form.neighbourhood,
      city: form.city,
      address: form.address,
      bedrooms: Number(form.bedrooms),
      baths: Number(form.baths),
      guests: Number(form.guests),
      nightlyRateCents: Math.round(Number(form.nightlyRate) * 100),
      cleaningFeeCents: Math.round(Number(form.cleaningFee || 0) * 100),
      ownerName: form.ownerName,
      ownerEmail: form.ownerEmail,
      managementFeePercent: Number(form.managementFeePercent),
      channels: form.channels,
      photoKey: form.photoUrl || null,
    };

    try {
      if (editing) {
        await sendJson('PATCH', `/api/properties/${editing.id}`, payload);
        toast('Changes saved');
      } else {
        await sendJson('POST', '/api/properties', payload);
        toast('Property added');
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save that property', 'error');
    }
  }

  async function toggleStatus(card: Card) {
    const next = card.status === 'live' ? 'onboarding' : 'live';
    try {
      await sendJson('PATCH', `/api/properties/${card.id}`, { status: next });
      toast(next === 'live' ? 'Property is live' : 'Property moved back to onboarding');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not change the status', 'error');
    }
  }

  async function openFeed(card: Card) {
    try {
      const data = await getJson<{ feeds: Feed[] }>(`/api/properties/${card.id}/calendar-feeds`);
      const first = data.feeds[0] ?? null;
      setSelectedId(card.id);
      setPanelOpen(true);
      setFeed(first);
      setFeedForm({ url: first?.url ?? '', source: first?.source ?? 'airbnb' });
      setAccountForm({
        label: (card.account?.label ?? '').replace(/ · pending$/, ''),
        verified: card.account?.verified ?? false,
        balance: card.account ? String(card.account.balanceCents / 100) : '',
      });
    } catch {
      toast('Could not read the calendar link', 'error');
    }
  }

  async function saveFeed() {
    if (!selectedId) return;
    try {
      await sendJson('PUT', `/api/properties/${selectedId}/calendar-feed`, feedForm);
      toast('The link is saved on the property, so you can refresh it any time.');
      await openFeed(cards!.find((card) => card.id === selectedId)!);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save that link', 'error');
    }
  }

  async function saveAccount() {
    if (!selectedId) return;
    try {
      await sendJson('PUT', `/api/properties/${selectedId}/account`, {
        label: accountForm.label,
        verified: accountForm.verified,
        balanceCents: Math.round(Number(accountForm.balance || 0) * 100),
      });
      toast('Account saved');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save that account', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!cards) return <p className="loading">Loading the properties…</p>;

  return (
    <div className="stack">
      <section className="panel-head panel-head-row">
        <div>
          <h2>Properties</h2>
          <p>{cards.length} in this portfolio.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={startAdd}>
          Add property
        </button>
      </section>

      {cards.length === 0 ? (
        <section className="empty">
          <h2>No properties yet</h2>
          <p>Add one property and the calendar starts holding nights in the same minute.</p>
          <button type="button" className="btn btn-primary" onClick={startAdd}>
            Add your first property
          </button>
        </section>
      ) : (
        <div className="prop-grid" data-testid="property-cards">
          {cards.map((card) => (
            <article className="prop-card" key={card.id} data-property={card.id}>
              <header className="prop-head">
                <div>
                  <h3>{card.name}</h3>
                  <p className="prop-place">
                    {[card.neighbourhood, card.city].filter(Boolean).join(' · ') || 'No location'}
                  </p>
                </div>
                <span className={`status status-${card.status}`}>
                  {card.status === 'live' ? 'Live' : 'Onboarding'}
                </span>
              </header>

              <p className="prop-spec">
                {card.bedrooms ?? '—'} beds · {card.baths ?? '—'} baths · sleeps {card.guests ?? '—'}
              </p>
              <p className="prop-rate">
                <strong>{money(card.nightlyRateCents, currency)}</strong> per night
                <small className="cell-note">
                  cleaning {money(card.cleaningFeeCents, currency)} · fee{' '}
                  {card.managementFeeBps === null ? 'inherited' : `${card.managementFeeBps / 100} %`}
                </small>
              </p>
              <p className="prop-rate">30-day occupancy: {card.occupancyPct} %</p>

              <p className="prop-badges">
                {CHANNEL_BADGES.filter((channel) => card.channels.includes(channel)).map((channel) => (
                  <span className={`badge ch-${channel}`} key={channel}>
                    {channel === 'booking_com' ? 'Booking.com' : channel}
                  </span>
                ))}
              </p>

              <p className="prop-account">
                {card.account ? (
                  <>
                    {card.account.label} · {money(card.account.balanceCents, currency)}
                    <small className="cell-note">
                      {card.account.verified ? 'Verified' : 'Pending'}
                    </small>
                  </>
                ) : (
                  <span className="muted">No settling account</span>
                )}
              </p>

              <p className="prop-next">
                Next arrival: {arrivalLabel(card.nextArrival)}
              </p>
              <p className="prop-owner">Owner: {card.ownerName ?? '—'}</p>

              <div className="prop-actions">
                <button type="button" className="btn" onClick={() => startEdit(card)}>
                  Edit
                </button>
                <button type="button" className="btn" onClick={() => toggleStatus(card)}>
                  {card.status === 'live' ? 'Move to onboarding' : 'Make live'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => openFeed(card)}
                  data-action="calendar"
                >
                  Calendar link
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {showForm ? (
        <section className="panel" aria-labelledby="property-form-title">
          <header className="panel-head">
            <h2 id="property-form-title">{editing ? `Edit ${editing.name}` : 'Add a property'}</h2>
            <p>Everything the card shows comes from these fields.</p>
          </header>
          <div className="settings-form">
            <div className="field">
              <label htmlFor="p-name">Name</label>
              <input
                id="p-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-status">Status</label>
              <select
                id="p-status"
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value })}
              >
                <option value="onboarding">Onboarding</option>
                <option value="live">Live</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="p-type">Type</label>
              <input
                id="p-type"
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-area">Neighbourhood</label>
              <input
                id="p-area"
                value={form.neighbourhood}
                onChange={(event) => setForm({ ...form, neighbourhood: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-city">City</label>
              <input
                id="p-city"
                value={form.city}
                onChange={(event) => setForm({ ...form, city: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-address">Address</label>
              <input
                id="p-address"
                value={form.address}
                onChange={(event) => setForm({ ...form, address: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-bedrooms">Bedrooms</label>
              <input
                id="p-bedrooms"
                inputMode="numeric"
                value={form.bedrooms}
                onChange={(event) => setForm({ ...form, bedrooms: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-baths">Baths</label>
              <input
                id="p-baths"
                inputMode="numeric"
                value={form.baths}
                onChange={(event) => setForm({ ...form, baths: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-guests">Sleeps</label>
              <input
                id="p-guests"
                inputMode="numeric"
                value={form.guests}
                onChange={(event) => setForm({ ...form, guests: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-rate">Nightly rate ({currency})</label>
              <input
                id="p-rate"
                inputMode="decimal"
                value={form.nightlyRate}
                onChange={(event) => setForm({ ...form, nightlyRate: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-cleaning">Cleaning fee ({currency})</label>
              <input
                id="p-cleaning"
                inputMode="decimal"
                value={form.cleaningFee}
                onChange={(event) => setForm({ ...form, cleaningFee: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-fee">Management fee (%)</label>
              <input
                id="p-fee"
                inputMode="decimal"
                value={form.managementFeePercent}
                onChange={(event) => setForm({ ...form, managementFeePercent: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-owner">Owner</label>
              <input
                id="p-owner"
                value={form.ownerName}
                onChange={(event) => setForm({ ...form, ownerName: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-owner-email">Owner email</label>
              <input
                id="p-owner-email"
                type="email"
                value={form.ownerEmail}
                onChange={(event) => setForm({ ...form, ownerEmail: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-photo">Photo URL</label>
              <input
                id="p-photo"
                value={form.photoUrl}
                onChange={(event) => setForm({ ...form, photoUrl: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-channels">Channels</label>
              <select
                id="p-channels"
                multiple
                value={form.channels}
                onChange={(event) =>
                  setForm({
                    ...form,
                    channels: Array.from(event.target.selectedOptions).map((option) => option.value),
                  })
                }
              >
                {CHANNEL_BADGES.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel === 'booking_com' ? 'Booking.com' : channel}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="panel-foot">
            <button type="button" className="btn btn-primary" onClick={save}>
              {editing ? 'Save changes' : 'Add property'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {panelOpen ? (
        <section className="panel" aria-labelledby="feed-title">
          <header className="panel-head">
            <h2 id="feed-title">Calendar link and account</h2>
            <p>The link is saved on the property, so you can refresh it any time.</p>
          </header>
          <div className="settings-form">
            <div className="field">
              <label htmlFor="feed-url">Calendar link</label>
              <input
                id="feed-url"
                value={feedForm.url}
                placeholder="https://www.airbnb.com/calendar/ical/123456.ics?s=…"
                onChange={(event) => setFeedForm({ ...feedForm, url: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="feed-source">Source</label>
              <select
                id="feed-source"
                value={feedForm.source}
                onChange={(event) => setFeedForm({ ...feedForm, source: event.target.value })}
              >
                {CHANNEL_BADGES.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel === 'booking_com' ? 'Booking.com' : channel}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="account-label">Account label</label>
              <input
                id="account-label"
                value={accountForm.label}
                onChange={(event) => setAccountForm({ ...accountForm, label: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="account-balance">Balance ({currency})</label>
              <input
                id="account-balance"
                inputMode="decimal"
                value={accountForm.balance}
                onChange={(event) => setAccountForm({ ...accountForm, balance: event.target.value })}
              />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={accountForm.verified}
                onChange={(event) =>
                  setAccountForm({ ...accountForm, verified: event.target.checked })
                }
              />
              <span>Verified</span>
            </label>
          </div>
          <div className="panel-foot">
            <button type="button" className="btn btn-primary" onClick={saveFeed}>
              Save link
            </button>
            <button type="button" className="btn" onClick={saveAccount}>
              Save account
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
