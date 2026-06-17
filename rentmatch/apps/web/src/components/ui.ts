/** Tiny presentational helpers shared across screens. */
const GRADIENTS = [
  'linear-gradient(135deg,#3b5bdb,#5f3dc4)', 'linear-gradient(135deg,#0b7285,#15aabf)',
  'linear-gradient(135deg,#2b8a3e,#66a80f)', 'linear-gradient(135deg,#c2255c,#e8590c)',
  'linear-gradient(135deg,#5c5f66,#343a40)', 'linear-gradient(135deg,#1864ab,#1098ad)',
  'linear-gradient(135deg,#862e9c,#d6336c)', 'linear-gradient(135deg,#e67700,#f59f00)',
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/** Deterministic placeholder "photo" gradient for a listing id. */
export function photoGradient(seed: string): string {
  return GRADIENTS[Math.abs(hash(seed)) % GRADIENTS.length];
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
