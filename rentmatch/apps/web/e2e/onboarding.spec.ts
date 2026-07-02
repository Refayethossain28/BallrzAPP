import { test, expect } from '@playwright/test';

/**
 * Emulator-backed onboarding e2e. Exercises the real Auth + Firestore paths
 * (no mocks): a landlord signs up, switches role, adds a track-only property,
 * and sees it persisted on the compliance dashboard.
 *
 * Run with the emulators up and the dev server pointed at them:
 *   npm run e2e:emulators
 * It is skipped in the plain `npm run e2e` smoke run (no emulators).
 */
test.skip(process.env.VITE_USE_EMULATORS !== '1', 'requires the Firebase emulators');

test('landlord signs up, adds a property, and it persists', async ({ page }) => {
  const email = `landlord+${Date.now()}@example.com`;

  // Sign up.
  await page.goto('/');
  await page.getByRole('link', { name: 'Create one' }).click();
  await page.getByLabel('Full name').fill('Test Landlord');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('hunter2pw');
  await page.getByRole('button', { name: 'Create account' }).click();

  // Become a landlord.
  await page.getByRole('button', { name: 'Landlord' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  // Add a track-only property.
  await page.goto('/landlord/track');
  await page.getByPlaceholder('14 Mapledene Road').fill('14 Mapledene Road');
  await page.getByPlaceholder('Hackney').fill('Hackney');
  await page.getByPlaceholder('London').fill('London');
  await page.getByPlaceholder('E8 3JN').fill('E8 3JN');
  await page.getByRole('button', { name: /Add property/ }).click();

  // Lands on the document vault for the new property.
  await expect(page.getByText('14 Mapledene Road, London')).toBeVisible();

  // And it shows on the compliance dashboard (read-back from Firestore).
  await page.goto('/landlord/compliance');
  await expect(page.getByText('14 Mapledene Road, London')).toBeVisible();
});
