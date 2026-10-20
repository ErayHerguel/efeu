// Erzeugt das efeu-Logo aus einer einzigen Geometrie-Beschreibung:
//   brand/efeu-icon.svg        – Master-Icon (1024 px, macOS-Raster mit Schatten)
//   src/assets/logo.svg        – Kachel ohne Rand/Schatten für die App-Oberfläche
//   src-tauri/icons/source.png – 1024×1024 PNG mit Transparenz für `tauri icon`
// Ohne externe Abhängigkeiten. Aufruf: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ---------- Geometrie (Kachel-Einheiten 0..128) ----------
const TILE_RADIUS = 28.5;
const LINES = [24, 44, 64, 84, 104];
const LINE_X0 = 16;
const LINE_X1 = 112;
const LINE_WIDTH = 3;
// Schriftzug „efeu“: Urbanist Regular, 44 px, mit Kerning, bereits horizontal zentriert (x 22.75–105.25);
// die Grundlinie (y 81) liegt auf der vierten Linie
const WORD_DX = 0;
const WORDMARK =
  'M33.75 81.572C31.726 81.572 29.8817 81.0513 28.217 80.01C26.5523 78.9687 25.225 77.5717 24.235 75.819C23.245 74.0663 22.75 72.1267 22.75 70C22.75 68.3867 23.036 66.8797 23.608 65.479C24.18 64.0783 24.9683 62.8463 25.973 61.783C26.9777 60.7197 28.1473 59.8873 29.482 59.286C30.8167 58.6847 32.2393 58.384 33.75 58.384C35.378 58.384 36.8777 58.7067 38.249 59.352C39.6203 59.9973 40.801 60.8993 41.791 62.058C42.781 63.2167 43.529 64.5733 44.035 66.128C44.541 67.6827 44.75 69.362 44.662 71.166L26.006 71.166C26.182 72.5593 26.6257 73.806 27.337 74.906C28.0483 76.006 28.9577 76.875 30.065 77.513C31.1723 78.151 32.4007 78.4773 33.75 78.492C35.2167 78.492 36.5403 78.1107 37.721 77.348C38.9017 76.5853 39.8513 75.5367 40.57 74.202L43.694 74.928C42.814 76.8787 41.4867 78.4737 39.712 79.713C37.9373 80.9523 35.95 81.572 33.75 81.572Z' +
  'M25.918 68.68L41.56 68.68C41.4573 67.316 41.043 66.0657 40.317 64.929C39.591 63.7923 38.656 62.883 37.512 62.201C36.368 61.519 35.114 61.178 33.75 61.178C32.386 61.178 31.1393 61.5117 30.01 62.179C28.8807 62.8463 27.9567 63.7483 27.238 64.885C26.5193 66.0217 26.0793 67.2867 25.918 68.68Z' +
  'M53.198 53.258L53.198 59L59.798 59L59.798 62.08L53.198 62.08L53.198 81L50.118 81L50.118 62.08L47.104 62.08L47.104 59L50.118 59L50.118 53.258C50.118 52.1873 50.3783 51.2157 50.899 50.343C51.4197 49.4703 52.12 48.7737 53 48.253C53.88 47.7323 54.8553 47.472 55.926 47.472C56.7033 47.472 57.455 47.626 58.181 47.934C58.907 48.242 59.556 48.6967 60.128 49.298L57.928 51.476C57.6933 51.1827 57.3963 50.9553 57.037 50.794C56.6777 50.6327 56.3073 50.552 55.926 50.552C55.178 50.552 54.5363 50.816 54.001 51.344C53.4657 51.872 53.198 52.51 53.198 53.258Z' +
  'M72.492 81.572C70.468 81.572 68.6237 81.0513 66.959 80.01C65.2943 78.9687 63.967 77.5717 62.977 75.819C61.987 74.0663 61.492 72.1267 61.492 70C61.492 68.3867 61.778 66.8797 62.35 65.479C62.922 64.0783 63.7103 62.8463 64.715 61.783C65.7197 60.7197 66.8893 59.8873 68.224 59.286C69.5587 58.6847 70.9813 58.384 72.492 58.384C74.12 58.384 75.6197 58.7067 76.991 59.352C78.3623 59.9973 79.543 60.8993 80.533 62.058C81.523 63.2167 82.271 64.5733 82.777 66.128C83.283 67.6827 83.492 69.362 83.404 71.166L64.748 71.166C64.924 72.5593 65.3677 73.806 66.079 74.906C66.7903 76.006 67.6997 76.875 68.807 77.513C69.9143 78.151 71.1427 78.4773 72.492 78.492C73.9587 78.492 75.2823 78.1107 76.463 77.348C77.6437 76.5853 78.5933 75.5367 79.312 74.202L82.436 74.928C81.556 76.8787 80.2287 78.4737 78.454 79.713C76.6793 80.9523 74.692 81.572 72.492 81.572Z' +
  'M64.66 68.68L80.302 68.68C80.1993 67.316 79.785 66.0657 79.059 64.929C78.333 63.7923 77.398 62.883 76.254 62.201C75.11 61.519 73.856 61.178 72.492 61.178C71.128 61.178 69.8813 61.5117 68.752 62.179C67.6227 62.8463 66.6987 63.7483 65.98 64.885C65.2613 66.0217 64.8213 67.2867 64.66 68.68Z' +
  'M86.066 72.574L86.066 59L89.146 59L89.146 71.958C89.146 73.1607 89.4393 74.2533 90.026 75.236C90.6127 76.2187 91.401 77.0033 92.391 77.59C93.381 78.1767 94.47 78.47 95.658 78.47C96.8607 78.47 97.9497 78.1767 98.925 77.59C99.9003 77.0033 100.6813 76.2187 101.268 75.236C101.8547 74.2533 102.148 73.1607 102.148 71.958L102.148 59L105.228 59L105.25 81L102.17 81L102.148 77.92C101.3707 79.0347 100.3623 79.922 99.123 80.582C97.8837 81.242 96.5307 81.572 95.064 81.572C93.4067 81.572 91.896 81.1687 90.532 80.362C89.168 79.5553 88.0827 78.47 87.276 77.106C86.4693 75.742 86.066 74.2313 86.066 72.574Z';
// Eselsohr oben rechts: Rechteck ab x=90 bis y=38 mit gerundeter Innenecke
const FOLD = { x: 90, y: 38, r: 12, stroke: 2.5, shadowDx: -1.5, shadowDy: 2 };

const COLORS = {
  paperTop: '#ffffff',
  paperBottom: '#f3f1ec',
  line: '#ece9e3',
  word: '#4a4946',
  foldLight: '#f2efea',
  foldDark: '#e2ded6',
  foldStroke: '#c9c4ba',
};

// ---------- SVG ----------
const foldPath = `M140 -12V${FOLD.y}H${FOLD.x + FOLD.r}A${FOLD.r} ${FOLD.r} 0 0 1 ${FOLD.x} ${FOLD.y - FOLD.r}V-12Z`;

function tileSvg({ shadow }) {
  const lines = LINES.map(
    (y) => `<path d="M${LINE_X0} ${y}H${LINE_X1}" stroke="${COLORS.line}" stroke-width="${LINE_WIDTH}" stroke-linecap="round"/>`,
  ).join('\n      ');
  return `<defs>
    <linearGradient id="paper" x1="0" y1="0" x2="0" y2="128" gradientUnits="userSpaceOnUse">
      <stop stop-color="${COLORS.paperTop}"/><stop offset="1" stop-color="${COLORS.paperBottom}"/>
    </linearGradient>
    <linearGradient id="fold" x1="128" y1="0" x2="90" y2="38" gradientUnits="userSpaceOnUse">
      <stop stop-color="${COLORS.foldLight}"/><stop offset="1" stop-color="${COLORS.foldDark}"/>
    </linearGradient>
    <clipPath id="tile"><rect width="128" height="128" rx="${TILE_RADIUS}"/></clipPath>
    <filter id="foldShadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter>${
      shadow
        ? `
    <filter id="tileShadow" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="0.8"/></filter>`
        : ''
    }
  </defs>${
    shadow
      ? `
  <rect y="1.55" width="128" height="128" rx="${TILE_RADIUS}" fill="#000" fill-opacity="0.3" filter="url(#tileShadow)"/>`
      : ''
  }
  <rect width="128" height="128" rx="${TILE_RADIUS}" fill="url(#paper)"/>
  <g clip-path="url(#tile)">
      ${lines}
      <path transform="translate(${WORD_DX} 0)" fill="${COLORS.word}" d="${WORDMARK}"/>
      <path transform="translate(${FOLD.shadowDx} ${FOLD.shadowDy})" d="${foldPath}" fill="#000" fill-opacity="0.12" filter="url(#foldShadow)"/>
      <path d="${foldPath}" fill="url(#fold)" stroke="${COLORS.foldStroke}" stroke-width="${FOLD.stroke}"/>
  </g>
  <rect x="0.4" y="0.4" width="127.2" height="127.2" rx="${TILE_RADIUS - 0.4}" fill="none" stroke="#000" stroke-opacity="0.07" stroke-width="0.8"/>`;
}

const iconSvg = `<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" xmlns="http://www.w3.org/2000/svg">
<g transform="translate(100 100) scale(6.4375)">
  ${tileSvg({ shadow: true })}
</g>
</svg>
`;
const logoSvg = `<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  ${tileSvg({ shadow: false })}
</svg>
`;

// ---------- Rasterisierung ----------
const SIZE = 1024;
const SS = 4; // 4×4 Supersampling
const SCALE = 824 / 128; // macOS-Raster: 824-px-Kachel mit 100 px Rand
const OFFSET = 100;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const C = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, hex(v)]));

function roundedRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
const tileSdf = (u, v) => roundedRect(u, v, 64, 64, 64, 64, TILE_RADIUS);
// Eselsohr als großes gerundetes Rechteck, dessen einzige sichtbare Ecke die Innenecke ist
const foldSdf = (u, v) => roundedRect(u, v, FOLD.x + 50, FOLD.y - 50, 50, 50, FOLD.r);

/** Zerlegt einen absoluten SVG-Pfad (M, L, H, V, C, Z) in Polygone. */
function pathToPolygons(d, dx) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const polys = [];
  let poly = null;
  let x = 0;
  let y = 0;
  let i = 0;
  let cmd = '';
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === 'M') {
      x = num(); y = num();
      poly = [[x + dx, y]];
      polys.push(poly);
      cmd = 'L';
    } else if (cmd === 'L') {
      x = num(); y = num();
      poly.push([x + dx, y]);
    } else if (cmd === 'H') {
      x = num();
      poly.push([x + dx, y]);
    } else if (cmd === 'V') {
      y = num();
      poly.push([x + dx, y]);
    } else if (cmd === 'C') {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let s = 1; s <= 12; s++) {
        const t = s / 12;
        const mt = 1 - t;
        const px = mt ** 3 * x + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t ** 3 * x3;
        const py = mt ** 3 * y + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t ** 3 * y3;
        poly.push([px + dx, py]);
      }
      x = x3; y = y3;
    } else if (cmd === 'Z' || cmd === 'z') {
      cmd = '';
    } else {
      throw new Error(`Nicht unterstützter Pfadbefehl ${cmd}`);
    }
  }
  return polys;
}

/** Abdeckungsmaske in Sample-Auflösung, Füllregel nonzero. */
function rasterizePath(d, dx) {
  const N = SIZE * SS;
  const mask = new Uint8Array(N * N);
  const edges = [];
  for (const poly of pathToPolygons(d, dx)) {
    for (let k = 0; k < poly.length; k++) {
      const [ux0, uy0] = poly[k];
      const [ux1, uy1] = poly[(k + 1) % poly.length];
      const toS = (u) => (OFFSET + u * SCALE) * SS;
      edges.push([toS(ux0), toS(uy0), toS(ux1), toS(uy1)]);
    }
  }
  for (let row = 0; row < N; row++) {
    const sy = row + 0.5;
    const hits = [];
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= sy && y1 > sy) || (y1 <= sy && y0 > sy)) {
        hits.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
      }
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a[0] - b[0]);
    let winding = 0;
    for (let h = 0; h < hits.length - 1; h++) {
      winding += hits[h][1];
      if (winding === 0) continue;
      const from = Math.max(0, Math.ceil(hits[h][0] - 0.5));
      const to = Math.min(N - 1, Math.floor(hits[h + 1][0] - 0.5));
      mask.fill(1, row * N + from, row * N + to + 1);
    }
  }
  return mask;
}

function renderPng() {
  const N = SIZE * SS;
  const word = rasterizePath(WORDMARK, WORD_DX);
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  const halfLine = LINE_WIDTH / 2;

  for (let py = 0; py < SIZE; py++) {
    const rowStart = py * (SIZE * 4 + 1);
    for (let px = 0; px < SIZE; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS - OFFSET) / SCALE;
          const v = (py + (sy + 0.5) / SS - OFFSET) / SCALE;
          const dTile = tileSdf(u, v);
          if (dTile > 0) continue;
          let c = mix(C.paperTop, C.paperBottom, clamp01(v / 128));
          for (const ly of LINES) {
            const cx = Math.max(LINE_X0, Math.min(LINE_X1, u));
            if (Math.hypot(u - cx, v - ly) <= halfLine) c = C.line;
          }
          if (word[(py * SS + sy) * N + px * SS + sx]) c = C.word;
          const dFold = foldSdf(u, v);
          if (dFold > FOLD.stroke / 2) {
            const dShadow = foldSdf(u - FOLD.shadowDx, v - FOLD.shadowDy);
            const shade = 0.12 * Math.exp(-((Math.max(dShadow, 0) / 2.2) ** 2));
            c = mix(c, [0, 0, 0], shade);
          } else if (dFold < -FOLD.stroke / 2) {
            c = mix(C.foldLight, C.foldDark, clamp01((128 - u + v) / 76));
          } else {
            c = C.foldStroke;
          }
          if (dTile > -0.8) c = mix(c, [0, 0, 0], 0.07);
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const cover = a / (SS * SS);
      // Schlagschatten nach Apples Icon-Vorlage (10 px Versatz, 10 px Weichzeichnung) unter dem freien Anteil
      const du = (px + 0.5 - OFFSET) / SCALE;
      const dv = (py + 0.5 - OFFSET) / SCALE - 1.55;
      const shadow = 0.3 * Math.exp(-((Math.max(tileSdf(du, dv), 0) / 1.15) ** 2));
      const shadowAlpha = shadow * (1 - cover);
      const alpha = cover + shadowAlpha;
      const o = rowStart + 1 + px * 4;
      if (alpha > 0) {
        // Schattenfarbe ist Schwarz: trägt nur Deckkraft bei
        raw[o] = Math.round(a ? (r / a) * (cover / alpha) : 0);
        raw[o + 1] = Math.round(a ? (g / a) * (cover / alpha) : 0);
        raw[o + 2] = Math.round(a ? (b / a) * (cover / alpha) : 0);
      }
      raw[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(raw);
}

// ---------- PNG-Kodierung ----------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('brand', { recursive: true });
mkdirSync('src/assets', { recursive: true });
mkdirSync('src-tauri/icons', { recursive: true });
writeFileSync('brand/efeu-icon.svg', iconSvg);
writeFileSync('src/assets/logo.svg', logoSvg);
writeFileSync('src-tauri/icons/source.png', renderPng());
console.log('brand/efeu-icon.svg, src/assets/logo.svg, src-tauri/icons/source.png geschrieben');
