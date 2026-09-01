'use client';

import { useState } from 'react';
import { refreshDocumentUrl } from './actions';

type DocumentCardProps = {
  documentName: string;
  url: string;
  // Row id for a generated document, or the storage path for a shared pack
  // file — whichever the card was built from (see getSignedSourceDocumentUrls
  // / getSignedPackFileCards, both of which set `id` accordingly).
  documentId?: string;
  isPackFile?: boolean;
};

// File-attachment card, not an inline PDF preview — per ui-context.md's
// chat-appropriate conventions, a real chat product shows attachments as
// cards. bg-surface + radius-md per Unit 10's design note.
//
// Sign-on-click (2026-09-01): the href is a signed Storage URL minted when
// the page rendered, so a chat left open past the TTL used to open to
// Supabase's `"exp" claim timestamp check failed`. The click now asks the
// server for a fresh URL first and opens that, falling back to the
// render-time href if the refresh fails (offline, session expired), so the
// card is never worse than before.
export function DocumentCard({ documentName, url, documentId, isPackFile }: DocumentCardProps) {
  const [isOpening, setIsOpening] = useState(false);

  async function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!documentId) {
      return; // No id available: keep the plain-href behaviour.
    }
    event.preventDefault();
    setIsOpening(true);
    // Opened synchronously, BEFORE awaiting: a window.open() after an await
    // is no longer tied to the click gesture and pop-up blockers kill it.
    // NOTE: no 'noopener' in the features string — it makes window.open()
    // return null, which previously left a blank tab behind while the PDF
    // loaded over the chat in the current window. The opener reference is
    // severed on the handle instead, which keeps the same protection.
    const tab = window.open('', '_blank');
    if (tab) {
      try {
        tab.opener = null;
      } catch {
        // Some browsers make `opener` read-only; harmless either way.
      }
      tab.document.write('Opening document…');
      tab.document.close();
    }
    try {
      const fresh = await refreshDocumentUrl(documentId, isPackFile ? 'pack-file' : 'source-document');
      const target = fresh ?? url;
      if (tab && !tab.closed) {
        tab.location.replace(target);
      } else {
        // Pop-up blocked (or the learner closed the tab): fall back to the
        // current window rather than silently doing nothing.
        window.location.href = target;
      }
    } catch {
      if (tab && !tab.closed) {
        tab.close();
      }
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
      className="flex items-center gap-3 rounded-md border border-border-default bg-bg-surface px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-bg-surface-raised"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className="h-5 w-5 shrink-0 text-text-secondary"
      >
        <path
          d="M6 2h8l4 4v16H6V2z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M14 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className="flex-1 truncate font-medium">{documentName}</span>
      <span className="shrink-0 text-xs text-accent">{isOpening ? 'Opening…' : 'View'}</span>
    </a>
  );
}
