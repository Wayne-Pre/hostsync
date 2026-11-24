import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from './client.ts';
import { useToast } from './toast.tsx';

/**
 * The field-worker screen. A cleaner signs in with their own account and sees
 * only the jobs assigned to them. Start, checklist, photo proof and Done are
 * attributed to that login, so the manager can see who actually did the work.
 */

interface Check {
  position: number;
  label: string;
  done: boolean;
}

interface Job {
  id: string;
  kind: string;
  title: string;
  propertyName: string;
  status: string;
  windowStart: string;
  windowEnd: string;
  checklist: Check[];
  checklistDone: number;
  checklistTotal: number;
}

interface Board {
  counters: { dueToday: number; blocked: number };
  columns: Array<{ key: string; tasks: Job[] }>;
}

interface MyJobsData {
  jobs: Board;
  worker: string;
}

interface ProofPhoto {
  id: string;
  dataUrl: string;
  caption: string | null;
  createdAt: string;
  by: string | null;
}

interface ProofEvent {
  id: string;
  action: string;
  createdAt: string;
  by: string | null;
}

const KIND_LABEL: Record<string, string> = {
  turnover: 'TURNOVER',
  maintenance: 'MAINTENANCE',
  inspection: 'INSPECTION',
  other: 'OTHER',
};

function windowText(job: Job): string {
  const format = (value: string) =>
    new Date(value).toLocaleString('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return `${format(job.windowStart)} – ${format(job.windowEnd)}`;
}

function readPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that photo'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('That file is not an image'));
      image.onload = () => {
        const scale = Math.min(1, 1200 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Could not prepare that photo'));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function logout(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  window.location.assign('/login');
}

export function MyJobs() {
  const toast = useToast();
  const [data, setData] = useState<MyJobsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [openJob, setOpenJob] = useState<string | null>(null);
  const [photos, setPhotos] = useState<ProofPhoto[]>([]);
  const [events, setEvents] = useState<ProofEvent[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getJson<MyJobsData>('/api/my-jobs'));
      setError(null);
    } catch {
      setError('Could not load your jobs. Sign in again if your session expired.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openProof(jobId: string) {
    const next = openJob === jobId ? null : jobId;
    setOpenJob(next);
    if (!next) return;
    try {
      const proof = await getJson<{ photos: ProofPhoto[]; events: ProofEvent[] }>(
        `/api/tasks/${jobId}/proof`
      );
      setPhotos(proof.photos);
      setEvents(proof.events);
    } catch {
      toast('Could not load the job history', 'error');
    }
  }

  async function act(job: Job, path: string, message: string) {
    setBusy(true);
    try {
      await sendJson('POST', `/api/tasks/${job.id}/${path}`);
      toast(message);
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not update that job', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function tick(job: Job, check: Check) {
    setBusy(true);
    try {
      await sendJson('POST', `/api/tasks/${job.id}/checklist`, {
        position: check.position,
        done: !check.done,
      });
      await load();
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not tick that item', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function upload(job: Job, file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await readPhoto(file);
      await sendJson('POST', `/api/tasks/${job.id}/photos`, {
        dataUrl,
        caption: 'Finished space',
      });
      toast('Photo saved as proof');
      await load();
      await openProof(job.id);
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : 'Could not save that photo', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="worker-screen">
        <p className="alert" role="alert">{error}</p>
      </div>
    );
  }
  if (!data) return <div className="worker-screen"><p className="loading">Loading your jobs…</p></div>;

  const jobs = data.jobs.columns.flatMap((column) => column.tasks);
  const active = jobs.filter((job) => job.status !== 'done');
  const done = jobs.filter((job) => job.status === 'done');
  const visible = showDone ? done : active;

  return (
    <div className="worker-screen">
      <header className="worker-topbar">
        <a className="worker-brand" href="/my-jobs">HostSync<span>.</span></a>
        <span className="worker-who">
          <strong>{data.worker}</strong>
          <small>Field work</small>
        </span>
        <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </header>

      <main className="worker-content">
        <p className="eyebrow">My jobs</p>
        <h1 className="worker-heading">Today&apos;s work, in your hands.</h1>
        <p className="muted">
          Every job here was assigned to you. Start it, tick the checklist, add a photo and mark it
          done — your name and time are recorded with each step.
        </p>

        <div className="worker-kpis">
          <div className="worker-kpi">
            <span>TO DO</span>
            <strong>{active.length}</strong>
          </div>
          <div className="worker-kpi">
            <span>DUE TODAY</span>
            <strong>{data.jobs.counters.dueToday}</strong>
          </div>
          <div className="worker-kpi">
            <span>DONE</span>
            <strong>{done.length}</strong>
          </div>
        </div>

        <div className="worker-tabs">
          <button
            type="button"
            className={showDone ? '' : 'is-active'}
            onClick={() => setShowDone(false)}
          >
            To do ({active.length})
          </button>
          <button
            type="button"
            className={showDone ? 'is-active' : ''}
            onClick={() => setShowDone(true)}
          >
            Done ({done.length})
          </button>
        </div>

        {visible.length === 0 ? (
          <p className="worker-empty">
            {showDone ? 'No completed jobs yet.' : 'Nothing assigned to you right now.'}
          </p>
        ) : (
          <ul className="worker-jobs">
            {visible.map((job) => {
              const complete = job.checklistTotal > 0 && job.checklistDone === job.checklistTotal;
              return (
                <li className="worker-job" key={job.id} data-task={job.id} data-testid="worker-job">
                  <div className="worker-job-top">
                    <span className={`kind kind-${job.kind}`}>{KIND_LABEL[job.kind] ?? job.kind}</span>
                    <span className="worker-status">{job.status === 'done' ? 'DONE' : job.status === 'in_progress' ? 'ON SITE' : 'SCHEDULED'}</span>
                  </div>
                  <h2>{job.title}</h2>
                  <p className="worker-property">{job.propertyName}</p>
                  <p className="worker-window">{windowText(job)}</p>

                  <ul className="worker-checklist">
                    {job.checklist.map((check) => (
                      <li key={check.position}>
                        <label>
                          <input
                            type="checkbox"
                            checked={check.done}
                            disabled={busy || job.status === 'done'}
                            onChange={() => void tick(job, check)}
                          />
                          <span>{check.label}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className="worker-progress">{job.checklistDone}/{job.checklistTotal} checks</p>

                  <div className="worker-actions">
                    {job.status === 'scheduled' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="worker-start"
                        disabled={busy}
                        onClick={() => void act(job, 'start', 'Job started')}
                      >
                        Start job
                      </button>
                    ) : null}
                    {job.status === 'in_progress' ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        data-testid="worker-done"
                        disabled={busy || !complete}
                        onClick={() => void act(job, 'complete', 'Job completed')}
                      >
                        {complete ? 'Mark done' : `Finish ${job.checklistTotal - job.checklistDone} checks first`}
                      </button>
                    ) : null}
                    {job.status === 'done' ? (
                      <button
                        type="button"
                        className="btn"
                        data-testid="worker-reopen"
                        disabled={busy}
                        onClick={() => void act(job, 'reopen', 'Job reopened')}
                      >
                        Reopen
                      </button>
                    ) : null}
                    <label className="btn worker-photo">
                      <input
                        type="file"
                        accept="image/*"
                        aria-label={`Add proof photo for ${job.title}`}
                        data-testid="worker-photo-input"
                        disabled={busy}
                        onChange={(event) => {
                          void upload(job, event.target.files?.[0]);
                          event.target.value = '';
                        }}
                      />
                      Add photo
                    </label>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      data-testid="worker-proof"
                      onClick={() => void openProof(job.id)}
                    >
                      {openJob === job.id ? 'Hide history' : 'History'}
                    </button>
                  </div>

                  {openJob === job.id ? (
                    <div className="worker-proof" data-testid="worker-proof-panel">
                      <h3>Proof &amp; history</h3>
                      {photos.length === 0 ? <p className="muted">No photos yet.</p> : null}
                      <div className="worker-photo-grid">
                        {photos.map((photo) => (
                          <img key={photo.id} src={photo.dataUrl} alt="Proof of completed work" />
                        ))}
                      </div>
                      <ol className="worker-events">
                        {events.map((event) => (
                          <li key={event.id}>
                            <strong>{event.by ?? 'System'}</strong> · {event.action.replace(/_/g, ' ')}{' '}
                            <small>{new Date(event.createdAt).toLocaleString('en-GB', {
                              timeZone: 'Africa/Nairobi',
                              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                            })}</small>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
