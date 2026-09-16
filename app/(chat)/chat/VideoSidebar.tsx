'use client';

import { useEffect, useRef } from 'react';
import { Play, X } from 'lucide-react';
import { SAMPLE_VIDEOS } from './video-sidebar-content';

type VideoSidebarProps = {
  // Mobile drawer only; the md+ aside is always shown.
  open: boolean;
  onClose: () => void;
};

// Sample titles only: the tiles are plain content, never links or buttons,
// so nothing on them looks clickable while no video backend exists.
function VideoLibrary() {
  return (
    <>
      <div>
        <h2 className="font-nunito text-lg font-semibold text-day-ink">Video library</h2>
        <p className="mt-1 font-nunito text-sm text-day-muted">Sample titles. Videos arrive in a later phase.</p>
      </div>
      <ul aria-label="Sample videos" className="space-y-3">
        {SAMPLE_VIDEOS.map((video) => (
          <li key={video.id} className="rounded-panel bg-day-card p-2">
            <div className="day-grid-paper relative flex aspect-video items-center justify-center rounded-2xl border border-day-line">
              <span className="day-disc flex size-10 items-center justify-center rounded-full text-day-blue">
                <Play aria-hidden="true" className="size-4" />
              </span>
              <span className="absolute top-2 left-2 rounded-full bg-white px-2.5 py-0.5 font-urbanist text-xs text-day-muted">
                Sample
              </span>
              <span className="absolute right-2 bottom-2 rounded-full bg-white px-2.5 py-0.5 font-urbanist text-xs text-day-ink">
                {video.duration}
              </span>
            </div>
            <p className="px-2 pt-2 pb-1 font-nunito text-sm font-medium text-day-ink">{video.title}</p>
          </li>
        ))}
      </ul>
    </>
  );
}

// The /chat video library: a persistent left column on md+, and an
// off-canvas drawer on small screens opened from the header. The drawer
// follows ReportIssue's hand-built modal pattern (backdrop click and Escape
// close it) and sits at z-40, under the z-50 onboarding and issue modals.
export function VideoSidebar({ open, onClose }: VideoSidebarProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus moves to the close button when the drawer opens and returns to
  // whatever opened it (the header's "Videos" button) when it closes. Keyed
  // on `open` alone, apart from the key listener, whose `onClose` is a fresh
  // function on every ChatShell render, so a re-render never moves focus.
  useEffect(() => {
    if (!open) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => opener?.focus();
  }, [open]);

  // No body scroll lock: the chat page is a fixed h-dvh column whose only
  // scroller is the message list, and the backdrop covers it, so nothing
  // behind the drawer can be scrolled.
  useEffect(() => {
    if (!open) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      // Focus trap. The tiles are plain content, so the close button is the
      // dialog's only focusable element and Tab keeps focus on it.
      if (event.key === 'Tab') {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  return (
    <>
      <aside
        id="video-library"
        aria-label="Video library"
        className="hidden w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-day-line bg-day-bg p-4 md:flex"
      >
        <VideoLibrary />
      </aside>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-day-ink/40" />
          <div
            id="video-library-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Video library"
            className="relative flex h-full w-[85%] max-w-sm flex-col gap-4 overflow-y-auto bg-day-bg p-4 shadow-dashboard"
          >
            <div className="flex justify-end">
              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                aria-label="Close video library"
                className="flex size-10 cursor-pointer items-center justify-center rounded-full border border-day-line bg-white text-day-ink transition-colors hover:border-day-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
            <VideoLibrary />
          </div>
        </div>
      )}
    </>
  );
}
