import { identifyTallyFile, type TallyFileKind } from '@/lib/parsing/identify-tally-file';
import { exportStepsFor, type ExportKind } from '@/lib/chat/export-instructions';

export type TallyUpload = { file: File; buffer: Buffer };

export type TallyUploadPairing =
  | { status: 'paired'; daybook: TallyUpload; trialbalance: TallyUpload }
  | { status: 'unpaired'; error: string };

const KIND_LABEL: Record<TallyFileKind, string> = {
  daybook: 'a Day Book',
  trialbalance: 'a Trial Balance',
  unknown: 'not a Tally export I recognize',
};

// GPT-style composer (2026-08-24): files arrive through one generic upload
// control, unlabeled. Which one is the Day Book and which the Trial Balance
// is decided by CONTENT (identifyTallyFile), never by filename or by which
// button was clicked. The first file of each kind wins and extra files are
// ignored (the client has already confirmed proceeding with the pair). Each
// buffer comes back with its file, so the caller uploads exactly the bytes
// that were classified.
export async function pairTallyUploads(files: File[]): Promise<TallyUploadPairing> {
  const classified = await Promise.all(
    files.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      return { file, buffer, kind: identifyTallyFile(buffer) };
    }),
  );

  const daybook = classified.find((entry) => entry.kind === 'daybook');
  const trialbalance = classified.find((entry) => entry.kind === 'trialbalance');

  if (daybook && trialbalance) {
    return {
      status: 'paired',
      daybook: { file: daybook.file, buffer: daybook.buffer },
      trialbalance: { file: trialbalance.file, buffer: trialbalance.buffer },
    };
  }

  const readableKinds = classified
    .map((entry) => `"${entry.file.name}" looks like ${KIND_LABEL[entry.kind]}`)
    .join('; ');
  // Which export is missing, and the steps to make it (2026-09-29).
  const missing: ExportKind[] = [...(daybook ? [] : ['daybook' as const]), ...(trialbalance ? [] : ['trialbalance' as const])];
  const found =
    missing.length === 2
      ? 'I could not find a Day Book or a Trial Balance in what you attached'
      : missing[0] === 'daybook'
        ? 'I have a Trial Balance but no Day Book in what you attached'
        : 'I have a Day Book but no Trial Balance in what you attached';
  return {
    status: 'unpaired',
    error: `${found}: ${readableKinds}.\n\n${exportStepsFor(missing)}\n\nThen attach both files here again.`,
  };
}
