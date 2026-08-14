'use client';

import { formatDuration, preview, type RunState, type StepState, type ToolAttempt } from '@/lib/agent';

function seqLabel(seq: number): string {
  return String(seq).padStart(3, '0');
}

function Attempt({ attempt }: { attempt: ToolAttempt }) {
  const retried = attempt.attempt > 1;
  const failed = attempt.settled && attempt.ok === false;

  return (
    <>
      <div className={`row${retried ? ' retry' : ''}`}>
        <span className="seq">{seqLabel(attempt.seq)}</span>
        <div className="label">
          {attempt.tool}
          {retried ? ` · attempt ${attempt.attempt}` : ''}
        </div>
        <div className="detail">{preview(attempt.args)}</div>
      </div>

      {attempt.settled ? (
        <div className={`row${retried ? ' retry' : ''}`}>
          <span className="seq" />
          <div className="detail">
            {failed ? (
              <span className="err">failed · {attempt.error}</span>
            ) : (
              <>
                <span className="dur">{formatDuration(attempt.durationMs)}</span>{' '}
                {preview(attempt.result, 90)}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className={`row${retried ? ' retry' : ''}`}>
          <span className="seq" />
          <div className="detail state-running">running…</div>
        </div>
      )}
    </>
  );
}

function Step({ step, live }: { step: StepState; live: boolean }) {
  const failures = step.attempts.filter((a) => a.ok === false).length;

  return (
    <section className="step">
      <div className="row">
        <span className="seq">{seqLabel(step.seq)}</span>
        <div className="step-head">
          <span className="n">step {step.index + 1}</span>
          {step.description}
        </div>
        {failures > 0 ? (
          <div className="detail err">
            recovered after {failures} failed {failures === 1 ? 'attempt' : 'attempts'}
          </div>
        ) : null}
      </div>

      {step.attempts.map((attempt) => (
        <Attempt key={attempt.callId} attempt={attempt} />
      ))}

      {step.narration ? (
        <p className="narration">
          {step.narration.trim()}
          {live && !step.done ? <span className="caret" aria-hidden="true" /> : null}
        </p>
      ) : null}
    </section>
  );
}

export default function Timeline({
  state,
  live,
}: {
  state: RunState;
  live: boolean;
}) {
  if (state.status === 'idle' && state.steps.length === 0) {
    return null;
  }

  const finished =
    state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled';

  return (
    <div className="timeline">
      {state.plan.length > 0 ? (
        <div className="row">
          <span className="seq">plan</span>
          <div className="detail">
            {state.plan.map((entry, index) => (
              <div key={entry + String(index)}>
                {index + 1}. {entry}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {state.steps.map((step) => (
        <Step key={step.index} step={step} live={live} />
      ))}

      {state.answer ? (
        <div className="answer">
          <span className="eyebrow" style={{ marginBottom: 0 }}>
            Answer
          </span>
          <p>{state.answer}</p>
        </div>
      ) : null}

      {state.error ? (
        <div className="answer bad">
          <span className="eyebrow" style={{ marginBottom: 0 }}>
            {state.status === 'cancelled' ? 'Cancelled' : 'Failed'}
          </span>
          <p>{state.error}</p>
        </div>
      ) : null}

      {state.lastSeq > 0 ? (
        <div className="cursor-note">
          {state.eventCount} events · cursor at <b>seq {state.lastSeq}</b>
          <br />
          {finished
            ? 'Reopening this run replays the same transcript from the store — the view above is rebuilt from events, not cached.'
            : 'Close this tab and come back: the browser sends this number as Last-Event-ID and the server resumes from exactly here.'}
        </div>
      ) : null}
    </div>
  );
}
