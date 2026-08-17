'use client';

import { useEffect, useState } from 'react';
import Timeline from '@/components/Timeline';
import {
  cancelRun,
  fetchBackend,
  startRun,
  useRunList,
  useRunStream,
  type Run,
} from '@/lib/agent';

const STATE_CLASS: Record<string, string> = {
  running: 'state-running',
  queued: 'state-running',
  succeeded: 'state-succeeded',
  failed: 'state-failed',
  cancelled: 'state-cancelled',
};

export default function Console() {
  const [goal, setGoal] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [backend, setBackend] = useState<string | null>(null);

  const runs = useRunList(refreshKey);
  const { state, connection } = useRunStream(runId);

  useEffect(() => {
    void fetchBackend().then(setBackend);
  }, []);

  // Refresh the sidebar once a run reaches a terminal state, so its status
  // there stops saying "running".
  useEffect(() => {
    if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
      setRefreshKey((key) => key + 1);
    }
  }, [state.status]);

  const live = connection === 'open' || connection === 'reconnecting';
  const active = state.status === 'running' || state.status === 'queued';

  async function submit() {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const run = await startRun(trimmed);
      setRunId(run.id);
      setGoal('');
      setRefreshKey((key) => key + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the run');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="shell">
      <header className="masthead">
        <span className="wordmark">Agent console</span>
        <p>Every step, every tool call, every failed attempt — as it happens.</p>
        <span className="spacer" />
        <span className="backend">
          store <strong>{backend ?? '…'}</strong>
          {runId ? (
            <>
              {' · '}stream <strong>{connection}</strong>
            </>
          ) : null}
        </span>
      </header>

      <div className="body">
        <aside className="sidebar">
          <p className="eyebrow">Runs</p>
          {runs.length === 0 ? (
            <span className="empty" style={{ fontSize: '0.85rem' }}>
              Nothing yet.
            </span>
          ) : (
            runs.map((run: Run) => (
              <button
                key={run.id}
                type="button"
                className="run-entry"
                aria-current={run.id === runId}
                onClick={() => setRunId(run.id)}
              >
                <span className="goal">{run.goal}</span>
                <span className={`meta ${STATE_CLASS[run.status] ?? ''}`}>{run.status}</span>
              </button>
            ))
          )}
        </aside>

        <main className="main">
          <div className="composer">
            <input
              value={goal}
              placeholder="Give the agent a goal"
              onChange={(event) => setGoal(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              aria-label="Goal"
            />
            <button type="button" onClick={() => void submit()} disabled={submitting || !goal.trim()}>
              {submitting ? 'Starting…' : 'Start run'}
            </button>
            {runId && active ? (
              <button type="button" className="ghost" onClick={() => void cancelRun(runId)}>
                Cancel
              </button>
            ) : null}
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          {!runId ? (
            <div className="empty">
              <p className="eyebrow">Nothing selected</p>
              <p>
                Start a run above, or pick one from the list to replay it. Replayed runs render from
                the stored event stream, so they look exactly like they did live.
              </p>
              <p>
                The agent plans its own steps, calls real tools, and streams every
                attempt as it happens. Failed calls stay visible next to the retry
                that recovered them. Close the tab mid-run and reopen it — the
                stream resumes where it left off.
              </p>
            </div>
          ) : (
            <Timeline state={state} live={live} />
          )}
        </main>
      </div>
    </div>
  );
}
