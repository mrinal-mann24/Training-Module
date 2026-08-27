'use client';

import { useRef, useState } from 'react';
import type { SubmissionPartType } from '@/lib/schemas/exercise';

// GPT-style composer (2026-08-24, user decision): one paperclip, one text
// box, one send — like ChatGPT/Claude. No labeled per-file buttons: learners
// attach any files in any order, the server identifies Day Book vs Trial
// Balance by CONTENT, and wrong counts are handled conversationally by
// ChatShell (attach 1 → the tutor asks for the second; attach 3+ → it asks
// whether to proceed with the pair it detects).
const TEXT_PART_PLACEHOLDER: Record<'explain_text' | 'review_text', string> = {
  explain_text: 'Explain why you posted these entries the way you did, then send.',
  review_text: 'Review the packet above and describe what looks right or wrong, then send.',
};

type ComposerProps = {
  disabled: boolean;
  // One unified send: whatever is attached plus whatever is typed. ChatShell
  // routes it (submission, question, or a conversational nudge about the
  // file count).
  onSend: (files: File[], text: string) => void;
  isSending: boolean;
  // Which parts the active exercise still needs (Unit 11) — drives the
  // placeholder and the explain/review "Ask instead" affordance.
  requiredParts: SubmissionPartType[];
  // Explicit question path when the text box doubles as a SUBMISSION part
  // (explain/review exercises) — everywhere else, plain text IS a question.
  onAskQuestion: (text: string) => void;
  isAsking: boolean;
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
  onAskQuestion,
  isAsking,
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

  const busy = isSending || isAsking;
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

  function handleAskInstead() {
    const text = textValue.trim();
    if (text.length === 0 || busy) {
      return;
    }
    setTextValue('');
    onAskQuestion(text);
  }

  return (
    <div className="border-t border-border-default bg-bg-canvas p-4">
      {/* Phase 4 (spec 16): composer width matches the chat column. */}
      <div className="mx-auto w-full max-w-[1150px]">
      {files.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="inline-flex items-center gap-2 rounded-sm bg-bg-surface px-2 py-1 text-xs text-text-secondary"
            >
              <span className="font-mono">{file.name}</span>
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                disabled={busy}
                aria-label={`Remove ${file.name}`}
                className="text-text-muted hover:text-text-primary disabled:cursor-not-allowed"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {fileError && <p className="mb-2 text-xs text-status-error">{fileError}</p>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || busy}
          aria-label="Attach files"
          title="Attach your Tally XML exports"
          className="shrink-0 rounded-full border border-border-default p-3 text-base text-text-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
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
          className="w-full rounded-xl border border-border-default bg-bg-surface px-4 py-3 text-base text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        {!disabled && textPartType && (
          <button
            type="button"
            onClick={handleAskInstead}
            disabled={textValue.trim().length === 0 || busy}
            className="shrink-0 rounded-md border border-border-default px-3 py-3 text-sm text-text-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAsking ? 'Asking…' : 'Ask instead'}
          </button>
        )}
        {!disabled && (
          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            className="shrink-0 rounded-md bg-accent px-4 py-3 text-base text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>

      {!disabled && (
        <div className="mt-2 flex justify-start">
          <button
            type="button"
            onClick={onRequestHint}
            disabled={isRequestingHint}
            className="rounded-full border border-border-default px-3 py-1.5 text-xs text-text-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
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
