/** Tiny presentational helpers shared across screens. */

const PALETTES = [
  { sky1: '#bfe3ff', sky2: '#7fb4e8', wall: '#ece3d4', wall2: '#dccfba', roof: '#7b4a3a', ground: '#cdbfae' },
  { sky1: '#ffd9a8', sky2: '#ff9e7d', wall: '#f1e7da', wall2: '#e5d6c4', roof: '#5b4a8a', ground: '#c9b29a' },
  { sky1: '#cfe9ff', sky2: '#9ec9f0', wall: '#dfe3ea', wall2: '#cdd3df', roof: '#3a4a6b', ground: '#b9c2cc' },
  { sky1: '#d7f0e6', sky2: '#9fd4c2', wall: '#efe9df', wall2: '#ddd5c7', roof: '#874c3a', ground: '#c2c7ba' },
  { sky1: '#e7dcff', sky2: '#b9a6f0', wall: '#ece6f3', wall2: '#dcd2ea', roof: '#4a3a6b', ground: '#bdb6c9' },
];
const GLASS = '#bfe0ff';

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function buildingSVG(seed: string): string {
  const h = Math.abs(hash(seed));
  const P = PALETTES[h % PALETTES.length];
  const v = h % 3;
  const fr = (x: number, y: number, w: number, hh: number) =>
    `<rect x="${x + w / 2 - 1}" y="${y}" width="2" height="${hh}" fill="#fff" opacity="0.5"/>` +
    `<rect x="${x}" y="${y + hh / 2 - 1}" width="${w}" height="2" fill="#fff" opacity="0.5"/>`;
  let scene = '';
  if (v === 0) {
    scene =
      `<rect x="244" y="84" width="15" height="30" fill="${P.roof}"/>` +
      `<polygon points="110,122 200,64 290,122" fill="${P.roof}"/>` +
      `<rect x="132" y="120" width="136" height="74" fill="${P.wall}"/>` +
      `<rect x="150" y="136" width="30" height="26" rx="2" fill="${GLASS}"/>` + fr(150, 136, 30, 26) +
      `<rect x="220" y="136" width="30" height="26" rx="2" fill="${GLASS}"/>` + fr(220, 136, 30, 26) +
      `<rect x="188" y="152" width="24" height="42" rx="2" fill="${P.roof}"/>` +
      `<rect x="184" y="190" width="32" height="5" fill="#b9ab98"/>` +
      `<circle cx="207" cy="174" r="2.4" fill="#e7d49a"/>`;
  } else if (v === 1) {
    let win = '';
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      const lit = (h >> (r * 4 + c)) & 1;
      win += `<rect x="${120 + c * 41}" y="${74 + r * 28}" width="27" height="18" rx="2" fill="${lit ? '#dff0ff' : '#9bb6d6'}"/>`;
    }
    scene =
      `<rect x="108" y="58" width="184" height="136" fill="${P.wall}"/>${win}` +
      `<rect x="176" y="154" width="48" height="9" fill="${P.roof}"/>` +
      `<rect x="186" y="162" width="28" height="32" fill="${P.roof}"/>`;
  } else {
    scene =
      `<rect x="96" y="112" width="104" height="82" fill="${P.wall}"/>` +
      `<polygon points="94,114 148,72 202,114" fill="${P.roof}"/>` +
      `<rect x="204" y="112" width="104" height="82" fill="${P.wall2}"/>` +
      `<polygon points="202,114 256,72 310,114" fill="${P.roof}"/>` +
      `<rect x="120" y="150" width="22" height="44" fill="${P.roof}"/>` +
      `<rect x="244" y="150" width="22" height="44" fill="${P.roof}"/>` +
      `<rect x="156" y="128" width="28" height="20" rx="2" fill="${GLASS}"/>` + fr(156, 128, 28, 20) +
      `<rect x="268" y="128" width="28" height="20" rx="2" fill="${GLASS}"/>` + fr(268, 128, 28, 20);
  }
  const tree =
    `<rect x="52" y="152" width="10" height="40" fill="#6b4a2a"/>` +
    `<circle cx="57" cy="146" r="22" fill="#5fa85f"/><circle cx="42" cy="157" r="15" fill="#52934c"/><circle cx="73" cy="157" r="15" fill="#6cb46d"/>`;
  const bushes = `<ellipse cx="322" cy="193" rx="30" ry="12" fill="#579c52"/><ellipse cx="112" cy="194" rx="22" ry="10" fill="#62a85d"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice">` +
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${P.sky1}"/><stop offset="1" stop-color="${P.sky2}"/></linearGradient></defs>` +
    `<rect width="400" height="240" fill="url(#s)"/>` +
    `<circle cx="330" cy="50" r="24" fill="#fff" opacity="0.85"/>` +
    `<ellipse cx="86" cy="52" rx="40" ry="14" fill="#fff" opacity="0.6"/>` +
    `<ellipse cx="150" cy="62" rx="30" ry="11" fill="#fff" opacity="0.45"/>` +
    `<rect x="0" y="186" width="400" height="54" fill="${P.ground}"/>` +
    `<rect x="0" y="182" width="400" height="8" fill="#7fae5e"/>` +
    `<rect x="0" y="190" width="400" height="3" fill="#000" opacity="0.07"/>` +
    tree + scene + bushes +
    `</svg>`
  );
}

/** A deterministic, offline generated "photo" of the property as a CSS background. */
export function photoGradient(seed: string): string {
  const svg = encodeURIComponent(buildingSVG(seed));
  return `#142033 url("data:image/svg+xml,${svg}") center/cover no-repeat`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
