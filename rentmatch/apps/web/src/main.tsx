/**
 * Web entry point (M0 placeholder). M1 mounts the React app (auth, listings,
 * search). For now this just proves the shared kernel is importable from the
 * web build — the same logic the Cloud Functions enforce.
 */
import { formatGBP, PLATFORM_FEE_PENCE } from '@rentmatch/shared';

const root = document.getElementById('root');
if (root) {
  root.textContent = `RentMatch — landlord platform fee is ${formatGBP(PLATFORM_FEE_PENCE)}. Web client lands in M1.`;
}
