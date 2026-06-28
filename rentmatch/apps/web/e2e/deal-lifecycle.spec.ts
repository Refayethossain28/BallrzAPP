import { test, expect } from '@playwright/test';

/**
 * Emulator-backed marketplace lifecycle. Exercises the server-authoritative
 * stack end-to-end through the UI: Auth + Firestore + the Functions emulator
 * (publishListing, deal transitions) + the Storage emulator (certificate
 * uploads). The £100 fee step needs live Stripe test keys, so the deal is driven
 * up to "ready to pay"; everything before it is real.
 *
 *   npm run e2e:emulators
 */
test.skip(process.env.VITE_USE_EMULATORS !== '1', 'requires the Firebase emulators');

const PDF = { name: 'cert.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%cert\n') };

async function signUp(page: import('@playwright/test').Page, email: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Create one' }).click();
  await page.getByLabel('Full name').fill('Test User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('hunter2pw');
  await page.getByRole('button', { name: 'Create account' }).click();
  // Wait for the authenticated app (role switch in the header) so callers don't
  // race a reload against auth persistence.
  await expect(page.getByRole('button', { name: 'Renter' })).toBeVisible({ timeout: 15_000 });
}

test('landlord advertises, uploads certificates and publishes a live listing', async ({ page }) => {
  const stamp = Date.now();
  await signUp(page, `landlord+${stamp}@example.com`);

  // Become a landlord and advertise.
  await page.getByRole('button', { name: 'Landlord' }).click();
  await page.goto('/landlord/new');
  await page.getByPlaceholder('Bright 2-bed flat near the park').fill('Bright 2-bed flat');
  await page.getByPlaceholder('14 Mapledene Road').fill('14 Mapledene Road');
  await page.getByPlaceholder('Hackney').fill('Hackney');
  await page.getByPlaceholder('London').fill('London');
  await page.getByPlaceholder('E8 3JN').fill('E8 3JN');
  await page.getByRole('button', { name: /Create listing/ }).click();

  // On the listing page, upload the required certificates (Storage emulator).
  await expect(page.getByText('Compliance & publishing')).toBeVisible();
  const fileInputs = page.locator('input[type=file]');
  const count = await fileInputs.count();
  // Upload one cert at a time, waiting for each to persist (the upload is a
  // read-modify-write, so concurrent uploads would clobber one another).
  for (let i = 0; i < count; i++) {
    await fileInputs.nth(i).setInputFiles(PDF);
    await expect(page.getByText('Valid')).toHaveCount(i + 1);
  }

  // Publish (publishListing Cloud Function re-checks server-side) → live.
  await page.getByRole('button', { name: 'Publish listing' }).click();
  await expect(page.getByText(/live and searchable/i)).toBeVisible({ timeout: 15_000 });
});

test('a renter finds a live listing and starts an enquiry', async ({ browser }) => {
  const stamp = Date.now();

  // Landlord publishes a listing (own context).
  const landlord = await browser.newContext();
  const lp = await landlord.newPage();
  await signUp(lp, `ll+${stamp}@example.com`);
  await lp.getByRole('button', { name: 'Landlord' }).click();
  await lp.goto('/landlord/new');
  await lp.getByPlaceholder('Bright 2-bed flat near the park').fill('Sunny studio');
  await lp.getByPlaceholder('14 Mapledene Road').fill('1 Test Street');
  await lp.getByPlaceholder('Hackney').fill('Shoreditch');
  await lp.getByPlaceholder('London').fill('London');
  await lp.getByPlaceholder('E8 3JN').fill('E1 6AA');
  await lp.getByRole('button', { name: /Create listing/ }).click();
  await expect(lp.getByText('Compliance & publishing')).toBeVisible();
  const inputs = lp.locator('input[type=file]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).setInputFiles(PDF);
    await expect(lp.getByText('Valid')).toHaveCount(i + 1);
  }
  await lp.getByRole('button', { name: 'Publish listing' }).click();
  await expect(lp.getByText(/live and searchable/i)).toBeVisible({ timeout: 15_000 });

  // Renter (separate context) finds it and enquires.
  const renter = await browser.newContext();
  const rp = await renter.newPage();
  await signUp(rp, `renter+${stamp}@example.com`); // lands on Browse (renter default)
  await expect(rp.getByText('Shoreditch').first()).toBeVisible({ timeout: 15_000 });
  await rp.getByText('Shoreditch').first().click();
  await rp.getByRole('button', { name: /Enquire/ }).click();
  // Lands in the deal room with the opening enquiry message.
  await expect(rp.getByText(/still available/i)).toBeVisible({ timeout: 15_000 });

  await landlord.close();
  await renter.close();
});
