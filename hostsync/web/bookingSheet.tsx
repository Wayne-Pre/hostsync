import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { channelLabel, getJson, longDayLabel, money, statusLabel } from './client.ts';

/**
 * F-32 — the booking detail sheet.
 *
 * One sheet, used by the ledger and by the calendar: a booking looks the same
 * wherever you open it, and the arithmetic it shows is the arithmetic the
 * database holds.
 */

export interface BookingDetail {
  booking: {
    id: string;
    reference: string;
    guestName: string;
    guestEmail: string | null;
    guestPhone: string | null;
    channel: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    guests: number;
    grossCents: number;
    commissionBps: number;
    netCents: number;
    paymentStatus: string;
    status: string;
    propertyName?: string;
    checkinTime?: string;
    checkoutTime?: string;
    channelLabel?: string;
  };
  overlaps: Array<{ reference: string; guestName: string; checkIn: string; checkOut: string }>;
  overlapWarning: string | null;
}

export function BookingSheet({
  id,
  onClose,
  onAction,
}: {
  id: string | null;
  onClose: () => void;
  /** Optional: confirm / cancel, for the places that own the action. */
  onAction?: (bookingId: string, action: 'confirm' | 'cancel') => void;
}) {
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    setDetail(null);
    setError(null);
    getJson<BookingDetail>(`/api/bookings/${id}`)
      .then(setDetail)
      .catch(() => setError('Could not load that stay.'));
  }, [id]);

  const booking = detail?.booking;

  return (
    <Dialog.Root open={id !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="sheet" aria-label="Booking detail" data-testid="booking-sheet">
          <Dialog.Title className="sheet-title">
            {booking ? booking.reference : 'Loading stay…'}
          </Dialog.Title>
          <Dialog.Description className="sheet-sub">
            {booking ? booking.guestName : 'Reading the booking'}
          </Dialog.Description>

          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}

          {booking ? (
            <dl className="sheet-grid">
              <div>
                <dt>Reference</dt>
                <dd data-testid="sheet-reference">{booking.reference}</dd>
              </div>
              <div>
                <dt>Channel</dt>
                <dd>{booking.channelLabel ?? channelLabel(booking.channel)}</dd>
              </div>
              <div>
                <dt>Property</dt>
                <dd>{booking.propertyName ?? '—'}</dd>
              </div>
              <div>
                <dt>Check-in</dt>
                <dd>
                  {longDayLabel(booking.checkIn)}
                  {booking.checkinTime ? ` · from ${booking.checkinTime}` : ''}
                </dd>
              </div>
              <div>
                <dt>Check-out</dt>
                <dd>
                  {longDayLabel(booking.checkOut)}
                  {booking.checkoutTime ? ` · by ${booking.checkoutTime}` : ''}
                </dd>
              </div>
              <div>
                <dt>Guests · nights</dt>
                <dd>
                  {booking.guests} guests · {booking.nights} nights
                </dd>
              </div>
              <div>
                <dt>Gross</dt>
                <dd>{money(booking.grossCents)}</dd>
              </div>
              <div>
                <dt>Channel commission</dt>
                <dd>{money(Math.round((booking.grossCents * booking.commissionBps) / 10_000))}</dd>
              </div>
              <div>
                <dt>Net to owner</dt>
                <dd>
                  <strong>{money(booking.netCents)}</strong>
                </dd>
              </div>
              <div>
                <dt>Payment</dt>
                <dd>{statusLabel(booking.paymentStatus)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{statusLabel(booking.status)}</dd>
              </div>
              <div>
                <dt>Contact</dt>
                <dd>
                  {booking.guestEmail ?? 'no email'}
                  {booking.guestPhone ? ` · ${booking.guestPhone}` : ''}
                </dd>
              </div>
            </dl>
          ) : null}

          {detail?.overlapWarning ? (
            <p className="alert alert-warn" role="alert" data-testid="overlap-warning">
              {detail.overlapWarning}
            </p>
          ) : null}

          {detail && detail.overlaps.length > 0 ? (
            <ul className="overlap-list">
              {detail.overlaps.map((other) => (
                <li key={other.reference}>
                  {other.guestName} · {other.reference} · {other.checkIn} → {other.checkOut}
                </li>
              ))}
            </ul>
          ) : null}

          {onAction && booking && booking.status !== 'cancelled' ? (
            <div className="sheet-actions">
              {booking.status === 'pending' ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  data-action="confirm"
                  onClick={() => onAction(booking.id, 'confirm')}
                >
                  Confirm stay
                </button>
              ) : null}
              <button
                type="button"
                className="btn"
                data-action="cancel"
                onClick={() => onAction(booking.id, 'cancel')}
              >
                Cancel
              </button>
            </div>
          ) : null}

          <Dialog.Close asChild>
            <button type="button" className="btn btn-block">
              Close
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
