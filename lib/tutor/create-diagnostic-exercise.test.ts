import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/db/queries/learner-profile', () => ({ getLearnerProfile: vi.fn() }));
vi.mock('@/lib/tutor/assign-pack-exercise', () => ({ assignPackDiagnostic: vi.fn() }));
vi.mock('@/lib/tutor/generate-exercise', () => ({ generateDiagnosticExercise: vi.fn() }));

import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { assignPackDiagnostic } from '@/lib/tutor/assign-pack-exercise';
import { generateDiagnosticExercise } from '@/lib/tutor/generate-exercise';
import { createDiagnosticExercise } from './create-diagnostic-exercise';

type LearnerProfile = NonNullable<Awaited<ReturnType<typeof getLearnerProfile>>>;

// Test doubles: the function only hands the clients to the (mocked) query and
// tutor functions, so an identity-tagged object is enough to check which
// client each call received.
const userClient = { client: 'user' } as unknown as SupabaseClient;
const serviceClient = { client: 'service' } as unknown as SupabaseClient;
const PARAMS = { supabase: userClient, serviceRoleClient: serviceClient, learnerId: 'learner-1' };

beforeEach(() => {
  vi.resetAllMocks();
});

describe('createDiagnosticExercise', () => {
  it('assigns the authored pack with the learner name and generates nothing', async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue({ full_name: 'Asha Rao' } as LearnerProfile);
    vi.mocked(assignPackDiagnostic).mockResolvedValue({ id: 'exercise-pack' });

    await expect(createDiagnosticExercise(PARAMS)).resolves.toBe('pack');

    expect(getLearnerProfile).toHaveBeenCalledWith(userClient, 'learner-1');
    expect(assignPackDiagnostic).toHaveBeenCalledWith(serviceClient, 'learner-1', 'Asha Rao', null);
    expect(generateDiagnosticExercise).not.toHaveBeenCalled();
  });

  it("passes an educational learner's license mode to the pack assignment (2026-09-16)", async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue({ full_name: 'Asha Rao', license_mode: 'educational' } as LearnerProfile);
    vi.mocked(assignPackDiagnostic).mockResolvedValue({ id: 'exercise-pack' });

    await expect(createDiagnosticExercise(PARAMS)).resolves.toBe('pack');

    expect(assignPackDiagnostic).toHaveBeenCalledWith(serviceClient, 'learner-1', 'Asha Rao', 'educational');
  });

  it('passes a null name when the learner has no profile row', async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue(null);
    vi.mocked(assignPackDiagnostic).mockResolvedValue({ id: 'exercise-pack' });

    await createDiagnosticExercise(PARAMS);

    expect(assignPackDiagnostic).toHaveBeenCalledWith(serviceClient, 'learner-1', null, null);
  });

  it('falls back to the generated diagnostic on the service-role client when no pack is seeded', async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue({ full_name: 'Asha Rao' } as LearnerProfile);
    vi.mocked(assignPackDiagnostic).mockResolvedValue(null);
    vi.mocked(generateDiagnosticExercise).mockResolvedValue({ id: 'exercise-generated' });

    await expect(createDiagnosticExercise(PARAMS)).resolves.toBe('generated');

    expect(generateDiagnosticExercise).toHaveBeenCalledWith(serviceClient, 'learner-1', 'licensed');
  });

  it("passes an educational learner's license mode to the generated diagnostic so its dates are postable (2026-09-16)", async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue({ full_name: 'Asha Rao', license_mode: 'educational' } as LearnerProfile);
    vi.mocked(assignPackDiagnostic).mockResolvedValue(null);
    vi.mocked(generateDiagnosticExercise).mockResolvedValue({ id: 'exercise-generated' });

    await createDiagnosticExercise(PARAMS);

    expect(generateDiagnosticExercise).toHaveBeenCalledWith(serviceClient, 'learner-1', 'educational');
  });

  it('defaults to licensed when the learner has no profile row', async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue(null);
    vi.mocked(assignPackDiagnostic).mockResolvedValue(null);
    vi.mocked(generateDiagnosticExercise).mockResolvedValue({ id: 'exercise-generated' });

    await createDiagnosticExercise(PARAMS);

    expect(generateDiagnosticExercise).toHaveBeenCalledWith(serviceClient, 'learner-1', 'licensed');
  });

  it('lets a failed profile read propagate before anything is assigned', async () => {
    vi.mocked(getLearnerProfile).mockRejectedValue(new Error('profile read failed'));

    await expect(createDiagnosticExercise(PARAMS)).rejects.toThrow('profile read failed');
    expect(assignPackDiagnostic).not.toHaveBeenCalled();
    expect(generateDiagnosticExercise).not.toHaveBeenCalled();
  });

  it('lets a failed pack assignment propagate without falling back to generation', async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue(null);
    vi.mocked(assignPackDiagnostic).mockRejectedValue(new Error('pack insert failed'));

    await expect(createDiagnosticExercise(PARAMS)).rejects.toThrow('pack insert failed');
    expect(generateDiagnosticExercise).not.toHaveBeenCalled();
  });

  it('lets a failed generation propagate', async () => {
    vi.mocked(getLearnerProfile).mockResolvedValue(null);
    vi.mocked(assignPackDiagnostic).mockResolvedValue(null);
    vi.mocked(generateDiagnosticExercise).mockRejectedValue(new Error('generation failed'));

    await expect(createDiagnosticExercise(PARAMS)).rejects.toThrow('generation failed');
  });
});
