import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { submissionXmlPaths, uploadSubmissionXmlFiles } from './submission-files';

type UploadCall = { bucket: string; path: string; body: Buffer; options: unknown };

// Records every upload in order. `failOn` names the path whose upload comes
// back with a Storage error.
function fakeStorageClient(failOn: string | null = null) {
  const calls: UploadCall[] = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Buffer, options: unknown) => {
          calls.push({ bucket, path, body, options });
          return path === failOn ? { data: null, error: new Error('storage down') } : { data: { path }, error: null };
        },
      }),
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const PATHS = submissionXmlPaths('learner-1', 'submission-1');
const BUFFERS = { daybook: Buffer.from('<daybook/>'), trialbalance: Buffer.from('<tb/>') };

describe('submissionXmlPaths', () => {
  it('puts both files under the learner id, then the submission id', () => {
    expect(PATHS).toEqual({
      daybookPath: 'learner-1/submission-1/daybook.xml',
      trialbalancePath: 'learner-1/submission-1/trialbalance.xml',
    });
  });
});

describe('uploadSubmissionXmlFiles', () => {
  it('uploads the Day Book then the Trial Balance to the submissions bucket as XML', async () => {
    const { client, calls } = fakeStorageClient();

    await expect(uploadSubmissionXmlFiles(client, PATHS, BUFFERS)).resolves.toEqual({ status: 'uploaded' });

    expect(calls).toEqual([
      {
        bucket: 'submissions',
        path: PATHS.daybookPath,
        body: BUFFERS.daybook,
        options: { contentType: 'application/xml', upsert: true },
      },
      {
        bucket: 'submissions',
        path: PATHS.trialbalancePath,
        body: BUFFERS.trialbalance,
        options: { contentType: 'application/xml', upsert: true },
      },
    ]);
  });

  // The permanent dead end this closes (2026-09-16): the path is derived from
  // the submission id, and submitFiles rejoins an open submission instead of
  // starting a new one, so a second send lands on the objects the first send
  // wrote. Without upsert, Storage answered "resource already exists" and the
  // learner was told to send both files again, which collided identically
  // every time. Overwriting is what makes the retry a self-heal.
  it('overwrites on a re-send rather than failing because the object exists', async () => {
    const { client, calls } = fakeStorageClient();

    await uploadSubmissionXmlFiles(client, PATHS, BUFFERS);
    await expect(uploadSubmissionXmlFiles(client, PATHS, BUFFERS)).resolves.toEqual({ status: 'uploaded' });

    expect(calls).toHaveLength(4);
    expect(calls.every((call) => (call.options as { upsert?: boolean }).upsert === true)).toBe(true);
  });

  it('stops after a failed Day Book upload without trying the Trial Balance', async () => {
    const { client, calls } = fakeStorageClient(PATHS.daybookPath);

    await expect(uploadSubmissionXmlFiles(client, PATHS, BUFFERS)).resolves.toEqual({ status: 'failed', file: 'daybook' });
    expect(calls.map((call) => call.path)).toEqual([PATHS.daybookPath]);
  });

  it('names the Trial Balance when only its upload fails', async () => {
    const { client, calls } = fakeStorageClient(PATHS.trialbalancePath);

    await expect(uploadSubmissionXmlFiles(client, PATHS, BUFFERS)).resolves.toEqual({
      status: 'failed',
      file: 'trialbalance',
    });
    expect(calls).toHaveLength(2);
  });

  it('lets an error thrown by the client propagate', async () => {
    const client = {
      storage: {
        from: () => ({
          upload: async () => {
            throw new Error('network gone');
          },
        }),
      },
    } as unknown as SupabaseClient;

    await expect(uploadSubmissionXmlFiles(client, PATHS, BUFFERS)).rejects.toThrow('network gone');
  });
});
