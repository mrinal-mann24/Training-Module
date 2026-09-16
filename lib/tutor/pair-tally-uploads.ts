import { identifyTallyFile, type TallyFileKind } from '@/lib/parsing/identify-tally-file';

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
  return {
    status: 'unpaired',
    error: `I couldn't find both files in what you attached: ${readableKinds}. I need one Detailed Day Book export and one Trial Balance export. Check the exports in Tally and send both again.`,
  };
}
