import { describe, expect, it, vi } from 'vitest';

// Stands in for the XML parsers: a file's CONTENT decides its kind, exactly
// as the real identifyTallyFile does, so these tests exercise the pairing and
// the learner-facing text without needing real Tally exports.
vi.mock('@/lib/parsing/identify-tally-file', () => ({
  identifyTallyFile: vi.fn((buffer: Buffer) => {
    const content = buffer.toString('utf8');
    return content === 'DAYBOOK' ? 'daybook' : content === 'TB' ? 'trialbalance' : 'unknown';
  }),
}));

import { pairTallyUploads } from './pair-tally-uploads';

function xmlFile(name: string, content: string): File {
  return new File([content], name, { type: 'application/xml' });
}

describe('pairTallyUploads', () => {
  it('pairs the files by content, never by filename or order', async () => {
    const result = await pairTallyUploads([xmlFile('trial-balance.xml', 'DAYBOOK'), xmlFile('daybook.xml', 'TB')]);

    expect(result.status).toBe('paired');
    if (result.status !== 'paired') {
      return;
    }
    expect(result.daybook.file.name).toBe('trial-balance.xml');
    expect(result.daybook.buffer.toString('utf8')).toBe('DAYBOOK');
    expect(result.trialbalance.file.name).toBe('daybook.xml');
    expect(result.trialbalance.buffer.toString('utf8')).toBe('TB');
  });

  it('takes the first file of each kind and ignores the rest', async () => {
    const result = await pairTallyUploads([
      xmlFile('notes.xml', 'OTHER'),
      xmlFile('day-1.xml', 'DAYBOOK'),
      xmlFile('day-2.xml', 'DAYBOOK'),
      xmlFile('tb.xml', 'TB'),
    ]);

    expect(result.status).toBe('paired');
    if (result.status !== 'paired') {
      return;
    }
    expect(result.daybook.file.name).toBe('day-1.xml');
    expect(result.trialbalance.file.name).toBe('tb.xml');
  });

  it('says what each file looks like, in upload order, when the Trial Balance is missing', async () => {
    const result = await pairTallyUploads([xmlFile('a.xml', 'DAYBOOK'), xmlFile('b.xml', 'DAYBOOK')]);

    expect(result).toEqual({
      status: 'unpaired',
      error:
        'I couldn\'t find both files in what you attached: "a.xml" looks like a Day Book; "b.xml" looks like a Day Book. I need one Detailed Day Book export and one Trial Balance export. Check the exports in Tally and send both again.',
    });
  });

  it('labels a file it cannot recognize when the Day Book is missing', async () => {
    const result = await pairTallyUploads([xmlFile('export.xml', 'OTHER'), xmlFile('tb.xml', 'TB')]);

    expect(result).toEqual({
      status: 'unpaired',
      error:
        'I couldn\'t find both files in what you attached: "export.xml" looks like not a Tally export I recognize; "tb.xml" looks like a Trial Balance. I need one Detailed Day Book export and one Trial Balance export. Check the exports in Tally and send both again.',
    });
  });
});
