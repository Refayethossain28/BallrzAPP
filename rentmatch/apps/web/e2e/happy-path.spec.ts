import { test, expect } from '@playwright/test';

/**
 * Happy-path e2e. Requires the Firebase Emulator Suite running and the dev
 * server pointed at it (VITE_USE_EMULATORS=1). The first test is a deterministic
 * smoke; the full lifecycle outline below documents the path a CI run drives
 * once seed users exist.
 */

test('sign-in screen renders and can switch to sign-up', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Apex', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Create one' }).click();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  await expect(page.getByLabel('Full name')).toBeVisible(); // label↔input association (a11y)
});

/**
 * Full lifecycle (run with seeded landlord + renter against the emulators):
 *  1. Landlord signs up → advertises a property → uploads EPC/EICR → Publish → live
 *  2. Renter signs up → searches → opens the listing → Enquire
 *  3. Both message; renter requests a viewing; landlord confirms
 *  4. Both "Agree to proceed"
 *  5. Landlord drafts the agreement → sends for e-signature
 *  6. Renter signs; landlord signs
 *  7. Landlord saves a (test) card and pays the £100 fee
 *  8. Deal shows "in force"; listing flips to "Let agreed"
 */
test.fixme('full landlord ↔ renter lifecycle to completion', async () => {});
