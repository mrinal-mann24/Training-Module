'use client';

import { useState, useTransition } from 'react';
import { ISSUE_MESSAGE_MAX_LENGTH } from '@/lib/chat/issue-limits';
import type { LearnerIssue } from '@/lib/db/queries/learner-issues';
import { reportIssue } from './actions';
import { IssueList } from './IssueList';

const SEND_FAILED_MESSAGE = "Your issue didn't go through just now. Please try again in a minute.";

// Next.js marks redirect() errors with a digest starting NEXT_REDIRECT.
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof error.digest === 'string' &&
    error.digest.startsWith('NEXT_REDIRECT')
  );
}

type ReportIssueProps = {
  // The learner's own issues, newest first, read server-side on page load.
  initialIssues: LearnerIssue[];
};

function FlagIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.87-.97A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.53" />
    </svg>
  );
}

// Learner issue reports (2026-09-15): a floating button over the bottom-right
// of the message area (positioned by ChatShell's relative wrapper, so it never
// covers the composer) opens a box to describe a problem. Issues go to the
// owner, not the tutor. The draft survives closing the box, so an accidental
// Escape or backdrop click loses nothing; it clears only once sent.
export function ReportIssue({ initialIssues }: ReportIssueProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [issues, setIssues] = useState<LearnerIssue[]>(initialIssues);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showSentNotice, setShowSentNotice] = useState(false);
  const [isSending, startSend] = useTransition();

  const canSend = draft.trim().length > 0 && !isSending;

  function openBox() {
    setErrorMessage(null);
    setShowSentNotice(false);
    setIsOpen(true);
  }

  function closeBox() {
    if (isSending) {
      return;
    }
    setIsOpen(false);
  }

  function handleSend() {
    if (!canSend) {
      return;
    }
    const message = draft.trim();
    setErrorMessage(null);
    setShowSentNotice(false);

    startSend(async () => {
      try {
        const result = await reportIssue(message);
        if (result.status === 'error') {
          setErrorMessage(result.error);
          return;
        }
        const sent = result.issue;
        // A resend of the same text comes back as the existing row, so it
        // replaces itself in the list instead of appearing twice.
        setIssues((current) => [sent, ...current.filter((issue) => issue.id !== sent.id)]);
        setDraft('');
        setShowSentNotice(true);
      } catch (error) {
        // An expired session makes the action call redirect('/login'), which
        // travels as a thrown NEXT_REDIRECT error: let it through so the
        // navigation happens. Anything else is the request failing outright
        // (offline, server restart mid-deploy). It is caught rather than
        // thrown, because the chat route has no error boundary to land on.
        if (isRedirectError(error)) {
          throw error;
        }
        setErrorMessage(SEND_FAILED_MESSAGE);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={openBox}
        aria-haspopup="dialog"
        aria-label="Report an issue"
        className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground shadow-dashboard transition-colors hover:bg-secondary sm:px-4"
      >
        <FlagIcon />
        <span className="hidden sm:inline">Report an issue</span>
      </button>

      {isOpen && (
        <div
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeBox();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              closeBox();
            }
          }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 px-4 py-8 font-body sm:items-center"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-issue-title"
            className="w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-dashboard"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="report-issue-title" className="text-xl font-semibold text-foreground">
                  Report an issue
                </h2>
                <p className="mt-1 text-sm text-text-secondary">
                  Tell us what went wrong. We can already see which batch you are on, so just describe the problem.
                </p>
              </div>
              <button
                type="button"
                onClick={closeBox}
                disabled={isSending}
                aria-label="Close"
                className="shrink-0 rounded-md px-2 text-xl leading-none text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                ×
              </button>
            </div>

            <label htmlFor="report-issue-message" className="sr-only">
              Describe the issue
            </label>
            <textarea
              id="report-issue-message"
              autoFocus
              rows={5}
              maxLength={ISSUE_MESSAGE_MAX_LENGTH}
              value={draft}
              disabled={isSending}
              onChange={(event) => {
                setDraft(event.target.value);
                setShowSentNotice(false);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  handleSend();
                }
              }}
              placeholder="For example: my June sales invoice shows the wrong invoice number."
              className="mt-4 w-full resize-y rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground placeholder:text-text-muted focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="mt-1 flex justify-between gap-2 text-xs text-text-muted">
              <span>Ctrl + Enter to send</span>
              <span>
                {draft.length}/{ISSUE_MESSAGE_MAX_LENGTH}
              </span>
            </div>

            {errorMessage && (
              <p role="alert" className="mt-3 text-sm text-status-error">
                {errorMessage}
              </p>
            )}
            {showSentNotice && (
              <p role="status" className="mt-3 text-sm text-status-success">
                Thanks, your issue is sent. We will look into it and reply here.
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeBox}
                disabled={isSending}
                className="rounded-md border border-border-default px-4 py-2 text-sm text-text-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className="rounded-md bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSending ? 'Sending…' : 'Send issue'}
              </button>
            </div>

            <IssueList issues={issues} />
          </div>
        </div>
      )}
    </>
  );
}
