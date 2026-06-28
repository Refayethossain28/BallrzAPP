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

type Page = import('@playwright/test').Page;

/** Switch to the landlord role and wait for it to take effect (it persists
 *  asynchronously; navigating before it lands leaves the deal room treating the
 *  user as a renter, since the party is derived from the active role). */
async function becomeLandlord(page: Page) {
  await page.getByRole('button', { name: 'Landlord' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

/** Open a deal as the landlord party. The deal room derives the party from the
 *  active role, so confirm the landlord role actually applied (force it if not). */
async function openDealAsLandlord(page: Page, dealId: string) {
  await page.goto(`/deal/${dealId}`);
  const landlordNav = page.getByRole('link', { name: /Compliance/ });
  if (!(await landlordNav.isVisible().catch(() => false))) {
    await becomeLandlord(page);
    await page.goto(`/deal/${dealId}`);
  }
  await expect(landlordNav).toBeVisible({ timeout: 15_000 });
}

/** Advertise a property, upload its certificates and publish it live. */
async function advertiseAndPublish(page: Page, opts: { title: string; street: string; area: string; city: string; postcode: string }) {
  await page.goto('/landlord/new');
  await page.getByPlaceholder('Bright 2-bed flat near the park').fill(opts.title);
  await page.getByPlaceholder('14 Mapledene Road').fill(opts.street);
  await page.getByPlaceholder('Hackney').fill(opts.area);
  await page.getByPlaceholder('London').fill(opts.city);
  await page.getByPlaceholder('E8 3JN').fill(opts.postcode);
  await page.getByRole('button', { name: /Create listing/ }).click();
  await expect(page.getByText('Compliance & publishing')).toBeVisible();
  const inputs = page.locator('input[type=file]');
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    await inputs.nth(i).setInputFiles(PDF);
    await expect(page.getByText('Valid')).toHaveCount(i + 1);
  }
  await page.getByRole('button', { name: 'Publish listing' }).click();
  await expect(page.getByText(/live and searchable/i)).toBeVisible({ timeout: 15_000 });
}

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
  await becomeLandlord(page);
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
  await becomeLandlord(lp);
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

test('a deal runs to completion and auto-creates a tenancy', async ({ browser, request }) => {
  const stamp = Date.now();

  // Landlord publishes a listing.
  const landlord = await browser.newContext();
  const lp = await landlord.newPage();
  await signUp(lp, `ll3+${stamp}@example.com`);
  await becomeLandlord(lp);
  await advertiseAndPublish(lp, { title: 'Garden flat', street: '7 Park Road', area: 'Peckham', city: 'London', postcode: 'SE15 5AA' });

  // Renter enquires.
  const renter = await browser.newContext();
  const rp = await renter.newPage();
  await signUp(rp, `rt3+${stamp}@example.com`);
  await expect(rp.getByText('Peckham').first()).toBeVisible({ timeout: 15_000 });
  await rp.getByText('Peckham').first().click();
  await rp.getByRole('button', { name: /Enquire/ }).click();
  await expect(rp).toHaveURL(/\/deal\//, { timeout: 15_000 });
  const dealId = rp.url().split('/deal/')[1].split('/')[0];

  // Renter proposes a viewing first…
  await rp.getByRole('button', { name: /Request a viewing/ }).click();
  await rp.locator('input[type=datetime-local]').fill('2027-06-01T12:00');
  await rp.getByRole('button', { name: 'Send proposal' }).click();
  await expect(rp.getByText(/awaiting confirmation/i)).toBeVisible({ timeout: 15_000 });

  // …then the landlord opens the deal (as landlord) and confirms it.
  await openDealAsLandlord(lp, dealId);
  await lp.getByRole('button', { name: 'Confirm viewing' }).click({ timeout: 15_000 });

  // Both agree to proceed. The renter agrees first; we wait for that to reach the
  // landlord before they agree, so the two writes don't clobber one another (the
  // agreement is a read-modify-write on the same field).
  await rp.getByRole('button', { name: /Agree to proceed/ }).click({ timeout: 15_000 });
  await expect(rp.getByRole('button', { name: /awaiting the other party/ })).toBeVisible({ timeout: 15_000 });
  await expect(lp.getByText('agreed to proceed to a tenancy')).toBeVisible({ timeout: 15_000 });
  await lp.getByRole('button', { name: /Agree to proceed/ }).click({ timeout: 15_000 });

  // Landlord drafts the agreement (→ contract view) and sends for e-signature.
  await lp.getByRole('button', { name: /Draft the tenancy agreement/ }).click({ timeout: 15_000 });
  await lp.getByRole('button', { name: /Send for e-signature/ }).click({ timeout: 15_000 });

  // Both parties sign.
  await rp.goto(`/deal/${dealId}/contract`);
  await rp.getByRole('button', { name: /Sign as/ }).click({ timeout: 15_000 });
  await expect(rp.getByText(/You've signed/i)).toBeVisible({ timeout: 15_000 });
  await lp.getByRole('button', { name: /Sign as/ }).click({ timeout: 15_000 });
  // Wait until both signatures are committed (landlord sees the fee prompt).
  await expect(lp.getByText(/Both parties have signed/i)).toBeVisible({ timeout: 15_000 });

  // The £100 fee is collected via Stripe Elements (untestable in-emulator), so
  // call the callable directly with the landlord's token + the Stripe fake.
  const token = await lp.evaluate(() =>
    (window as unknown as { __getIdToken: () => Promise<string | null> }).__getIdToken());
  const res = await request.post(
    'http://127.0.0.1:5001/demo-rentmatch/us-central1/chargePlatformFee',
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data: { data: { dealId } } },
  );
  expect(res.ok()).toBeTruthy();

  // The deal is now in force…
  await expect(lp.getByText(/in force/i)).toBeVisible({ timeout: 15_000 });

  // …and the deal→tenancy bridge created a tenancy (visible on the Rent tab).
  await lp.goto('/landlord/rent');
  await expect(lp.getByText('Test User')).toBeVisible({ timeout: 15_000 });

  await landlord.close();
  await renter.close();
});
