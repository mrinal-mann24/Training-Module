import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExercisePack } from '@/lib/db/queries/exercise-packs';
import {
  assignPackDiagnostic,
  educationalStoragePath,
  resolvePackFilesForLicense,
  type AssignPackDiagnosticDeps,
  type ListPackFolder,
} from './assign-pack-exercise';

// Never touched directly: every query and the Storage listing are injected.
const supabase = {} as unknown as SupabaseClient;

const PACK_FILES = [
  { label: 'Opening TB & Company Master', storage_path: 'variant-a/1-opening-tb.xlsx' },
  { label: 'Sales Register', storage_path: 'variant-a/2-sales-register.xlsx' },
  { label: 'Purchase Register', storage_path: 'variant-a/3-purchase-register.xlsx' },
  { label: 'Bank Statement', storage_path: 'variant-a/4-bank-statement.xlsx' },
];
const UPLOADED_NAMES = ['1-opening-tb.xlsx', '2-sales-register.xlsx', '3-purchase-register.xlsx', '4-bank-statement.xlsx'];

const PACK: ExercisePack = {
  id: 'pack-1',
  variant: 'A',
  company_name: 'Blossom Retail Pvt Ltd',
  day1_message: 'Hi {{name}}.',
  pack_files: PACK_FILES,
  answer_key: {
    entries: [
      {
        sequence: 1,
        correct_account: 'Sales Account',
        dr_cr: 'Cr',
        amount: 95000,
        voucher_type: 'Sales',
        narration: null,
      },
    ],
  } as unknown as ExercisePack['answer_key'],
  expected_voucher_count: 99,
};

function listing(names: string[]) {
  return vi.fn<ListPackFolder>().mockResolvedValue(names);
}

function makeDeps(overrides: AssignPackDiagnosticDeps = {}) {
  return {
    getPackByVariant: vi.fn<NonNullable<AssignPackDiagnosticDeps['getPackByVariant']>>().mockResolvedValue(PACK),
    getAnyPack: vi.fn<NonNullable<AssignPackDiagnosticDeps['getAnyPack']>>().mockResolvedValue(PACK),
    insertPackExercise: vi
      .fn<NonNullable<AssignPackDiagnosticDeps['insertPackExercise']>>()
      .mockResolvedValue({ id: 'exercise-1' }),
    registerCompanyLedgers: vi.fn<NonNullable<AssignPackDiagnosticDeps['registerCompanyLedgers']>>().mockResolvedValue(),
    appendCompanyTransactionLog: vi
      .fn<NonNullable<AssignPackDiagnosticDeps['appendCompanyTransactionLog']>>()
      .mockResolvedValue(),
    listPackFolder: listing(UPLOADED_NAMES),
    ...overrides,
  };
}

describe('educationalStoragePath', () => {
  it('suffixes the first path segment with -edu and keeps the file name', () => {
    expect(educationalStoragePath('variant-a/2-sales-register.xlsx')).toBe('variant-a-edu/2-sales-register.xlsx');
    expect(educationalStoragePath('variant-b/4-bank-statement.xlsx')).toBe('variant-b-edu/4-bank-statement.xlsx');
    expect(educationalStoragePath('variant-a/nested/file.xlsx')).toBe('variant-a-edu/nested/file.xlsx');
  });

  it('returns null for a path with no folder', () => {
    expect(educationalStoragePath('1-opening-tb.xlsx')).toBeNull();
    expect(educationalStoragePath('/1-opening-tb.xlsx')).toBeNull();
  });
});

describe('resolvePackFilesForLicense', () => {
  it('serves the re-dated copies to an educational learner once every copy is uploaded', async () => {
    const list = listing(UPLOADED_NAMES);

    const files = await resolvePackFilesForLicense(supabase, PACK_FILES, 'educational', list);

    expect(files).toEqual([
      { label: 'Opening TB & Company Master', storage_path: 'variant-a-edu/1-opening-tb.xlsx' },
      { label: 'Sales Register', storage_path: 'variant-a-edu/2-sales-register.xlsx' },
      { label: 'Purchase Register', storage_path: 'variant-a-edu/3-purchase-register.xlsx' },
      { label: 'Bank Statement', storage_path: 'variant-a-edu/4-bank-statement.xlsx' },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(supabase, 'variant-a-edu');
  });

  it('keeps the original files when nothing is uploaded yet', async () => {
    await expect(resolvePackFilesForLicense(supabase, PACK_FILES, 'educational', listing([]))).resolves.toBe(PACK_FILES);
  });

  it('keeps the original files when only some copies are uploaded, never a mix', async () => {
    const partial = listing(['1-opening-tb.xlsx', '2-sales-register.xlsx']);

    await expect(resolvePackFilesForLicense(supabase, PACK_FILES, 'educational', partial)).resolves.toBe(PACK_FILES);
  });

  it('keeps the original files when the Storage listing fails', async () => {
    const failing = vi.fn<ListPackFolder>().mockRejectedValue(new Error('storage down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(resolvePackFilesForLicense(supabase, PACK_FILES, 'educational', failing)).resolves.toBe(PACK_FILES);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never lists Storage for a licensed learner or an unknown mode', async () => {
    const list = listing(UPLOADED_NAMES);

    await expect(resolvePackFilesForLicense(supabase, PACK_FILES, 'licensed', list)).resolves.toBe(PACK_FILES);
    await expect(resolvePackFilesForLicense(supabase, PACK_FILES, null, list)).resolves.toBe(PACK_FILES);
    await expect(resolvePackFilesForLicense(supabase, PACK_FILES, undefined, list)).resolves.toBe(PACK_FILES);
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps the original files when a path has no folder to swap', async () => {
    const flat = [{ label: 'Loose file', storage_path: 'loose.xlsx' }];
    const list = listing(['loose.xlsx']);

    await expect(resolvePackFilesForLicense(supabase, flat, 'educational', list)).resolves.toBe(flat);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('assignPackDiagnostic', () => {
  it('stores the re-dated file paths on an educational learner exercise, labels unchanged', async () => {
    const deps = makeDeps();

    await expect(assignPackDiagnostic(supabase, 'learner-1', 'Asha Rao', 'educational', deps)).resolves.toEqual({
      id: 'exercise-1',
    });

    expect(deps.insertPackExercise).toHaveBeenCalledWith(
      supabase,
      'learner-1',
      expect.objectContaining({
        day1Message: 'Hi Asha.',
        packFiles: PACK_FILES.map((file) => ({ ...file, storage_path: file.storage_path.replace('variant-a/', 'variant-a-edu/') })),
        answerKey: PACK.answer_key,
        expectedVoucherCount: 99,
      }),
    );
  });

  it('stores the original paths for a licensed learner', async () => {
    const deps = makeDeps();

    await assignPackDiagnostic(supabase, 'learner-1', 'Asha Rao', 'licensed', deps);

    expect(deps.insertPackExercise).toHaveBeenCalledWith(
      supabase,
      'learner-1',
      expect.objectContaining({ packFiles: PACK_FILES }),
    );
    expect(deps.listPackFolder).not.toHaveBeenCalled();
  });

  it('stores the original paths for an educational learner before the copies are uploaded', async () => {
    const deps = makeDeps({ listPackFolder: listing([]) });

    await assignPackDiagnostic(supabase, 'learner-1', null, 'educational', deps);

    expect(deps.insertPackExercise).toHaveBeenCalledWith(
      supabase,
      'learner-1',
      expect.objectContaining({ day1Message: 'Hi there.', packFiles: PACK_FILES }),
    );
  });

  it('returns null and inserts nothing when no pack is seeded', async () => {
    const deps = makeDeps({
      getPackByVariant: vi.fn().mockResolvedValue(null),
      getAnyPack: vi.fn().mockResolvedValue(null),
    });

    await expect(assignPackDiagnostic(supabase, 'learner-1', null, 'educational', deps)).resolves.toBeNull();
    expect(deps.insertPackExercise).not.toHaveBeenCalled();
  });
});
