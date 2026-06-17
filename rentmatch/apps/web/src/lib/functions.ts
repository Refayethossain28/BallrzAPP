import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { app } from './firebase';

export const functions = getFunctions(app);

if (import.meta.env.VITE_USE_EMULATORS === '1') {
  connectFunctionsEmulator(functions, 'localhost', 5001);
}

/** Server-authoritative: only the landlord, only when both parties agreed. */
export const draftContract = httpsCallable<{ dealId: string }, { contractId: string; stage: string }>(
  functions,
  'draftContract',
);
