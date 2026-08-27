import { z } from 'zod';

export const LICENSE_MODES = ['licensed', 'educational'] as const;
export type LicenseMode = (typeof LICENSE_MODES)[number];

export const OnboardingInputSchema = z.object({
  // Unit 14R: used for the tutor's personalized Day-1 greeting.
  full_name: z.string().trim().min(1, 'Please enter your name.').max(120),
  license_mode: z.enum(LICENSE_MODES),
  books_begin_date: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Books Begin Date must be a valid date.',
  }),
});

export type OnboardingInput = z.infer<typeof OnboardingInputSchema>;
