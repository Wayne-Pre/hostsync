import { useCallback, useEffect, useState } from 'react';
import { channelLabel, getJson, money, moneyCompact, sendJson, statusLabel } from './client.ts';
import { BookingSheet } from './bookingSheet.tsx';
import { useToast } from './toast.tsx';

/**
 * F-28 ledger · F-29 counters · F-30 search · F-31 filters · F-32 detail sheet
 * F-33 confirm · F-34 cancel · F-35 new booking with live pricing
 */

interface Booking {
  id: string;
  reference: string;
  guestName: string;
  channel: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  grossCents: number;
  netCents: number;
  paymentStatus: string;
  status: string;
  propertyName: string;
}

interface Summary {
  inHouseNow: number;
  arriving: number;
  netBookedCents: number;
}

interface PropertyOption {
  id: string;
  name: string;
}

interface Quote {
  price: { grossCents: number; commissionBps: number; netCents: number; nights: number };
  summary: string;
  channelLabel: string;
}

const CHANNEL_OPTIONS = ['airbnb', 'booking_com', 'vrbo', 'direct', 'whatsapp'];
const STATUS_OPTIONS = ['confirmed', 'pending', 'completed', 'cancelled'];

export function Bookings() {
  const toast = useToast();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [currency, setCurrency] = useState('KES');
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    propertyId: '',
    guestName: '',
    channel: 'direct',
    checkIn: '',
    checkOut: '',
    guests: '2',
    guestEmail: '',
    guestPhone: '',
    notes: '',
  });
  const [quote, setQuote] = useState<Quote | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (status) params.set('status', status);
      if (channel) params.set('channel', channel);

      const [ledger, counters, propertyList] = await Promise.all([
        getJson<{ bookings: Booking[] }>(`/api/bookings?${params.toString()}`),
        getJson<Summary>('/api/bookings/summary'),
        getJson<{ properties: Array<{ id: string; name: string }> }>('/api/properties'),
      ]);

      setBookings(ledger.bookings);
      setSummary(counters);
      setProperties(propertyList.properties);
      setError(null);
    } catch {
      setError('Could not load the bookings.');
    }
  }, [search, status, channel]);

  useEffect(() => {
    void load();
  }, [load]);

  // The live price, asked of the server — the browser never does the maths.
  useEffect(() => {
    if (!form.propertyId || !form.checkIn || !form.checkOut) {
      setQuote(null);
      return;
    }
    const params = new URLSearchParams({
      propertyId: form.propertyId,
      checkIn: form.checkIn,
      checkOut: form.checkOut,
      guests: form.guests,
      channel: form.channel,
    });
    getJson<Quote>(`/api/bookings/quote?${params.toString()}`)
      .then(setQuote)
      .catch(() => setQuote(null));
  }, [form.propertyId, form.checkIn, form.checkOut, form.guests, form.channel]);

  async function act(bookingId: string, action: 'confirm' | 'cancel') {
    try {
      await sendJson('POST', `/api/bookings/${bookingId}/${action}`, {});
      toast(action === 'confirm' ? 'Stay confirmed' : 'Stay cancelled — the nights are free again');
      setOpenId(null);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not do that', 'error');
    }
  }

  async function create() {
    try {
      await sendJson('POST', '/api/bookings', {
        propertyId: form.propertyId,
        guestName: form.guestName,
        channel: form.channel,
        checkIn: form.checkIn,
        checkOut: form.checkOut,
        guests: Number(form.guests),
        guestEmail: form.guestEmail || null,
        guestPhone: form.guestPhone || null,
        notes: form.notes || null,
      });
      toast('Booking saved — a turnover will be scheduled for the check-in day');
      setForm({ ...form, guestName: '', guestEmail: '', guestPhone: '', notes: '' });
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save that booking', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="stack">
      <section className="kpis" aria-label="Ledger counters">
        <article className="kpi" data-kpi="in-house">
          <span className="kpi-label">In house now</span>
          <strong className="kpi-value">{summary?.inHouseNow ?? 0}</strong>
          <span className="kpi-note">guests staying tonight</span>
        </article>
        <article className="kpi" data-kpi="arriving">
          <span className="kpi-label">Arriving</span>
          <strong className="kpi-value">{summary?.arriving ?? 0}</strong>
          <span className="kpi-note">confirmed stays ahead</span>
        </article>
        <article className="kpi" data-kpi="net-booked">
          <span className="kpi-label">Net booked</span>
          <strong className="kpi-value">{moneyCompact(summary?.netBookedCents ?? 0, currency)}</strong>
          <span className="kpi-note">after channel commission</span>
        </article>
      </section>

      <section className="panel" aria-labelledby="ledger-title">
        <header className="panel-head chart-head">
          <h2 id="ledger-title">Ledger</h2>
          <div className="filters">
            <label htmlFor="ledger-search" className="sr-only">
              Search
            </label>
            <input
              id="ledger-search"
              type="search"
              placeholder="Guest, property or reference"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <label htmlFor="ledger-status" className="sr-only">
              Status
            </label>
            <select
              id="ledger-status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {statusLabel(option)}
                </option>
              ))}
            </select>
            <label htmlFor="ledger-channel" className="sr-only">
              Channel
            </label>
            <select
              id="ledger-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              <option value="">All channels</option>
              {CHANNEL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {channelLabel(option)}
                </option>
              ))}
            </select>
          </div>
        </header>

        <table className="table" data-testid="ledger">
          <thead>
            <tr>
              <th scope="col">Guest</th>
              <th scope="col">Reference</th>
              <th scope="col">Property</th>
              <th scope="col">Stay</th>
              <th scope="col">Nights · guests</th>
              <th scope="col">Channel</th>
              <th scope="col">Net</th>
              <th scope="col">Payment</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {(bookings ?? []).map((booking) => (
              <tr
                key={booking.id}
                data-booking={booking.id}
                data-status={booking.status}
                onClick={() => setOpenId(booking.id)}
                className="row-click"
              >
                <th scope="row">{booking.guestName}</th>
                <td>{booking.reference}</td>
                <td>{booking.propertyName}</td>
                <td>
                  {booking.checkIn} → {booking.checkOut}
                </td>
                <td>
                  {booking.nights} nights · {booking.guests} guests
                </td>
                <td>{channelLabel(booking.channel)}</td>
                <td>{money(booking.netCents, currency)}</td>
                <td>{statusLabel(booking.paymentStatus)}</td>
                <td>
                  <span className={`status status-${booking.status}`}>{statusLabel(booking.status)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {bookings && bookings.length === 0 ? (
          <p className="board-empty" style={{ padding: '18px' }}>
            Nothing matches those filters.
          </p>
        ) : null}
      </section>

      <section className="panel" aria-labelledby="new-booking-title">
        <header className="panel-head">
          <h2 id="new-booking-title">New booking</h2>
          <p>The price is the server’s, and a turnover is scheduled with it.</p>
        </header>
        <div className="settings-form">
          <div className="field">
            <label htmlFor="b-property">Property</label>
            <select
              id="b-property"
              value={form.propertyId}
              onChange={(event) => setForm({ ...form, propertyId: event.target.value })}
            >
              <option value="">Choose…</option>
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="b-guest">Guest name</label>
            <input
              id="b-guest"
              value={form.guestName}
              onChange={(event) => setForm({ ...form, guestName: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="b-channel">Channel</label>
            <select
              id="b-channel"
              value={form.channel}
              onChange={(event) => setForm({ ...form, channel: event.target.value })}
            >
              {CHANNEL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {channelLabel(option)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="b-in">Check-in</label>
            <input
              id="b-in"
              type="date"
              value={form.checkIn}
              onChange={(event) => setForm({ ...form, checkIn: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="b-out">Check-out</label>
            <input
              id="b-out"
              type="date"
              value={form.checkOut}
              onChange={(event) => setForm({ ...form, checkOut: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="b-guests">Guests</label>
            <input
              id="b-guests"
              inputMode="numeric"
              value={form.guests}
              onChange={(event) => setForm({ ...form, guests: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="b-email">Guest email</label>
            <input
              id="b-email"
              type="email"
              value={form.guestEmail}
              onChange={(event) => setForm({ ...form, guestEmail: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="b-phone">Guest phone</label>
            <input
              id="b-phone"
              value={form.guestPhone}
              onChange={(event) => setForm({ ...form, guestPhone: event.target.value })}
            />
          </div>
        </div>

        {quote ? (
          <dl className="statement-preview" data-testid="quote">
            <div>
              <dt>Stay</dt>
              <dd>{quote.price.nights} nights</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd>{money(quote.price.grossCents, currency)}</dd>
            </div>
            <div>
              <dt>Channel commission</dt>
              <dd>{money(Math.round((quote.price.grossCents * quote.price.commissionBps) / 10_000), currency)}</dd>
            </div>
            <div>
              <dt>Net to owner</dt>
              <dd>
                <strong>{money(quote.price.netCents, currency)}</strong>
              </dd>
            </div>
          </dl>
        ) : null}

        <div className="panel-foot">
          <button type="button" className="btn btn-primary" onClick={create}>
            Save booking
          </button>
        </div>
      </section>

      <BookingSheet id={openId} onClose={() => setOpenId(null)} onAction={act} />
    </div>
  );
}
