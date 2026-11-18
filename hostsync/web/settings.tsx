import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * F-73 portfolio details · F-74 review automation · F-75 channel states
 */

interface Settings {
  name: string;
  currency: string;
  timezone: string;
  defaultManagementFeeBps: number;
  businessName: string | null;
  businessPhone: string | null;
}

interface ChannelState {
  channel: string;
  label: string;
  connected: boolean;
  businessNumber: string | null;
}

interface ReviewSettings {
  autoRequest: boolean;
  daysAfterCheckout: number;
}

export function SettingsScreen() {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [channels, setChannels] = useState<ChannelState[]>([]);
  const [reviews, setReviews] = useState<ReviewSettings | null>(null);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [portfolio, channelList, reviewSettings] = await Promise.all([
        getJson<{ settings: Settings }>('/api/portfolio/settings'),
        getJson<{ channels: ChannelState[] }>('/api/channels'),
        getJson<{ settings: ReviewSettings }>('/api/reviews'),
      ]);
      setSettings(portfolio.settings);
      setDraft(portfolio.settings);
      setChannels(channelList.channels);
      setReviews(reviewSettings.settings);
      setError(null);
    } catch {
      setError('Could not load the settings.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePortfolio() {
    try {
      const result = await sendJson<{ settings: Settings }>('PATCH', '/api/portfolio/settings', {
        name: draft.name,
        currency: draft.currency,
        timezone: draft.timezone,
        managementFeePercent:
          draft.defaultManagementFeeBps === undefined
            ? undefined
            : draft.defaultManagementFeeBps / 100,
        businessName: draft.businessName ?? null,
        businessPhone: draft.businessPhone ?? null,
      });
      setSettings(result.settings);
      setDraft(result.settings);
      toast('Portfolio updated');
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save the portfolio', 'error');
    }
  }

  async function toggleChannel(channel: ChannelState, connected: boolean) {
    try {
      await sendJson('POST', `/api/channels/${channel.channel}`, {
        connected,
        businessNumber: channel.businessNumber,
      });
      toast(connected ? `${channel.label} connected` : `${channel.label} disconnected`);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not change that channel', 'error');
    }
  }

  async function setBusinessNumber(channel: ChannelState, value: string) {
    try {
      await sendJson('POST', `/api/channels/${channel.channel}`, {
        connected: channel.connected,
        businessNumber: value,
      });
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save that number', 'error');
    }
  }

  async function saveReviews(autoRequest: boolean, daysAfterCheckout: number) {
    try {
      await sendJson('PUT', '/api/reviews/settings', { autoRequest, daysAfterCheckout });
      toast('Review automation updated');
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save the review settings', 'error');
    }
  }

  if (error) {
    return (
      <p className="alert" role="alert">
        {error}
      </p>
    );
  }
  if (!settings || !reviews) return <p className="loading">Loading the settings…</p>;

  return (
    <div className="stack">
      <section className="panel" aria-labelledby="portfolio-title">
        <header className="panel-head">
          <h2 id="portfolio-title">Portfolio</h2>
          <p>The workspace every property and statement belongs to.</p>
        </header>
        <div className="settings-form">
          <div className="field">
            <label htmlFor="portfolio-name">Name</label>
            <input
              id="portfolio-name"
              value={draft.name ?? ''}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="portfolio-currency">Currency</label>
            <input
              id="portfolio-currency"
              maxLength={3}
              value={draft.currency ?? ''}
              onChange={(event) => setDraft({ ...draft, currency: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="portfolio-timezone">Timezone</label>
            <input
              id="portfolio-timezone"
              value={draft.timezone ?? ''}
              onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="portfolio-fee">Management fee (%)</label>
            <input
              id="portfolio-fee"
              inputMode="decimal"
              value={String((draft.defaultManagementFeeBps ?? 0) / 100)}
              onChange={(event) =>
                setDraft({ ...draft, defaultManagementFeeBps: Number(event.target.value) * 100 })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="portfolio-business-name">Business name</label>
            <input
              id="portfolio-business-name"
              value={draft.businessName ?? ''}
              onChange={(event) => setDraft({ ...draft, businessName: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="portfolio-business-phone">Business phone</label>
            <input
              id="portfolio-business-phone"
              value={draft.businessPhone ?? ''}
              onChange={(event) => setDraft({ ...draft, businessPhone: event.target.value })}
            />
          </div>
          <button type="button" className="btn btn-primary" onClick={savePortfolio}>
            Save portfolio
          </button>
        </div>
      </section>

      <section className="panel" aria-labelledby="automation-title">
        <header className="panel-head">
          <h2 id="automation-title">Review automation</h2>
          <p>Ask every guest for a review, and how long after checkout.</p>
        </header>
        <div className="settings-row">
          <label className="switch">
            <input
              type="checkbox"
              checked={reviews.autoRequest}
              onChange={(event) => void saveReviews(event.target.checked, reviews.daysAfterCheckout)}
            />
            <span>
              Auto-request {reviews.daysAfterCheckout}d after checkout
            </span>
          </label>
          <label className="field-inline">
            Days after checkout
            <input
              type="number"
              min={0}
              max={30}
              defaultValue={reviews.daysAfterCheckout}
              onBlur={(event) => void saveReviews(reviews.autoRequest, Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="panel" aria-labelledby="channels-title">
        <header className="panel-head">
          <h2 id="channels-title">Channels</h2>
          <p>What is connected. WhatsApp needs a business number.</p>
        </header>
        <ul className="request-list" data-testid="channel-list">
          {channels.map((channel) => (
            <li key={channel.channel} data-channel={channel.channel}>
              <span>
                {channel.label}
                {channel.channel === 'whatsapp' ? (
                  <input
                    className="inline-input"
                    aria-label={`${channel.label} business number`}
                    placeholder="Business number"
                    defaultValue={channel.businessNumber ?? ''}
                    onBlur={(event) => void setBusinessNumber(channel, event.target.value)}
                  />
                ) : null}
              </span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={channel.connected}
                  onChange={(event) => void toggleChannel(channel, event.target.checked)}
                />
                <span>{channel.connected ? 'Connected' : 'Not connected'}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
