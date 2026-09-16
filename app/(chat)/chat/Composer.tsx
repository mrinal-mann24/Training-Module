'use client';

import { useRef, useState } from 'react';
import type { SubmissionPartType } from '@/lib/schemas/exercise';

// GPT-style composer (2026-08-24, user decision): one paperclip, one text
// box, one send — like ChatGPT/Claude. No labeled per-file buttons: learners
// attach any files in any order, the server identifies Day Book vs Trial
// Balance by CONTENT, and wrong counts are handled conversationally by
// ChatShell (attach 1 → the tutor asks for the second; attach 3+ → it asks
// whether to proceed with the pair it detects).
// Smart Send (2026-09-15): the same Send takes a question or the typed
// explanation/review. The server works out which, and an answer is only filed
// after the learner confirms it in the chat.
const TEXT_PART_PLACEHOLDER: Record<'explain_text' | 'review_text', string> = {
  explain_text: 'Type your explanation, or ask me a question, then send.',
  review_text: 'Type your review of the packet, or ask me a question, then send.',
};

type ComposerProps = {
  disabled: boolean;
  // One unified send: whatever is attached plus whatever is typed. ChatShell
  // routes it (submission, question, or a conversational nudge about the
  // file count).
  onSend: (files: File[], text: string) => void;
  isSending: boolean;
  // Which parts the active exercise still needs (Unit 11); drives the
  // placeholder.
  requiredParts: SubmissionPartType[];
  // Incremented by ChatShell when a send was fully dispatched — clears the
  // attached files. (Files deliberately survive a send that ChatShell turned
  // into a "you're missing the second file" nudge, so the learner just adds
  // the other file and hits send again.)
  resetSignal: number;
  hasRequestedHint: boolean;
  isRequestingHint: boolean;
  onRequestHint: () => void;
};

export function Composer({
  disabled,
  onSend,
  isSending,
  requiredParts,
  resetSignal,
  hasRequestedHint,
  isRequestingHint,
  onRequestHint,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [textValue, setTextValue] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);

  // Render-phase reset (the React-docs "adjusting state when props change"
  // pattern, preferred over an effect): a bumped resetSignal means ChatShell
  // fully dispatched the last send, so the attached files clear.
  const [lastResetSignal, setLastResetSignal] = useState(resetSignal);
  if (lastResetSignal !== resetSignal) {
    setLastResetSignal(resetSignal);
    setFiles([]);
  }

  const textPartType = requiredParts.includes('explain_text')
    ? 'explain_text'
    : requiredParts.includes('review_text')
      ? 'review_text'
      : null;

  const busy = isSending;
  const canSend = !disabled && !busy && (files.length > 0 || textValue.trim().length > 0);

  function handleAttach(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = '';
    const invalid = selected.find((file) => !file.name.toLowerCase().endsWith('.xml'));
    if (invalid) {
      setFileError(`"${invalid.name}" isn't an .xml file. Attach Tally XML exports.`);
      return;
    }
    setFileError(null);
    setFiles((current) => [...current, ...selected]);
  }

  function handleSend() {
    if (!canSend) {
      return;
    }
    const text = textValue.trim();
    setTextValue('');
    onSend(files, text);
  }

  return (
    <div className="border-t border-day-line bg-day-bg px-4 py-4 md:px-8">
      {/* Phase 4 (spec 16): composer width matches the chat column. */}
      <div className="mx-auto w-full max-w-[1150px]">
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex items-center gap-2 rounded-full border border-day-line bg-white px-3 py-1 text-xs text-day-muted"
            >
              <span className="font-mono">{file.name}</span>
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                disabled={busy}
                aria-label={`Remove ${file.name}`}
                className="text-day-muted hover:text-day-ink disabled:cursor-not-allowed"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {fileError && <p className="mb-2 text-xs text-status-error">{fileError}</p>}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || busy}
          aria-label="Attach files"
          title="Attach your Tally XML exports"
          className="flex size-12 shrink-0 items-center justify-center rounded-full border border-day-line bg-white text-base text-day-muted hover:border-day-blue hover:text-day-blue disabled:cursor-not-allowed disabled:opacity-60"
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xml"
          multiple
          onChange={handleAttach}
          disabled={disabled}
          className="hidden"
        />
        <input
          type="text"
          disabled={disabled}
          value={textValue}
          onChange={(event) => setTextValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSend) {
              handleSend();
            }
          }}
          placeholder={
            disabled
              ? 'Complete the walkthrough to continue…'
              : textPartType
                ? TEXT_PART_PLACEHOLDER[textPartType]
                : 'Message your tutor: ask anything, or attach your exports and send…'
          }
          className="day-input h-12 w-full rounded-full px-5 font-nunito text-base disabled:cursor-not-allowed disabled:opacity-60"
        />
        {!disabled && (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="inline-flex h-12 shrink-0 items-center rounded-full bg-day-blue px-6 font-urbanist text-base text-white transition-colors hover:bg-day-blue-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>

      {!disabled && (
        <div className="mt-3 flex justify-start">
          <button
            type="button"
            onClick={onRequestHint}
            disabled={isRequestingHint}
            className="rounded-full border border-day-line bg-white px-4 py-1.5 font-urbanist text-sm text-day-muted hover:border-day-blue hover:text-day-blue disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isRequestingHint
              ? 'Getting help…'
              : hasRequestedHint
                ? 'Still stuck? Get more help'
                : "I'm stuck, help me"}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
