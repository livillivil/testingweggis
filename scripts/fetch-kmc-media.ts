/**
 * KMC-GIS-SERVER Automated Official Asset Bootstrap Script (100% Bun Runtime)
 * Executed via: bun run scripts/fetch-kmc-media.ts
 *
 * Verifies local presence of the official Kathmandu Metropolitan City & Nepal
 * assets and downloads any that are missing straight into the two canonical
 * public directories of the deployed Next.js apps:
 *
 *   frontend/public/  -> authenticated field workbench (PWA)
 *   geoportal/public/ -> public GeoPortal (basePath /geoportal)
 *
 * There is intentionally no third copy: the retired Vite preview tree and the
 * nested `*/public/geoportal/*` duplicates are gone (see _archive/README.md).
 *
 * Google Drive source IDs:
 *  - KMC.png:        1F6vivlLVK6vn1j9FlRRBD5-2kxcieuze
 *  - Nepal.png:      1tyP1K-kFSqrTY8bteKAoLj2Gg6_yn-GA
 *  - Nepal_flag.webp:1jE3_lWmjOYGWBThCzsgkkQde3LRg_7Xs
 *  - kmc-poster.jpg: 1D_eu32d8ZUZaG6tWRuZRfOJlZKn967Ye
 *  - kmc-intro.mp4:  1w9fteI4JSdVqMzc1NOHKWQhrN2HhPhYE  (optional flyover video,
 *    not referenced by the shipped GeoPortal; download manually if wanted)
 */

import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface AssetTarget {
  name: string;
  driveId: string;
  paths: string[];
}

const OFFICIAL_ASSETS: AssetTarget[] = [
  {
    name: 'KMC.png',
    driveId: '1F6vivlLVK6vn1j9FlRRBD5-2kxcieuze',
    paths: [
      'frontend/public/assets/KMC.png',
      'geoportal/public/assets/KMC.png',
    ],
  },
  {
    name: 'Nepal.png',
    driveId: '1tyP1K-kFSqrTY8bteKAoLj2Gg6_yn-GA',
    paths: [
      'frontend/public/assets/Nepal.png',
      'frontend/public/assets/Nepal.jpg',
      'geoportal/public/assets/Nepal.png',
    ],
  },
  {
    name: 'Nepal_flag.webp',
    driveId: '1jE3_lWmjOYGWBThCzsgkkQde3LRg_7Xs',
    paths: [
      'frontend/public/assets/Nepal_flag.webp',
      'geoportal/public/assets/Nepal_flag.webp',
    ],
  },
  {
    name: 'kmc-poster.jpg',
    driveId: '1D_eu32d8ZUZaG6tWRuZRfOJlZKn967Ye',
    paths: [
      'geoportal/public/videos/kmc-poster.jpg',
    ],
  },
];

async function ensureAsset(asset: AssetTarget) {
  const primaryPath = asset.paths[0];
  if (!existsSync(primaryPath)) {
    mkdirSync(dirname(primaryPath), { recursive: true });
    const url = `https://drive.usercontent.google.com/download?id=${asset.driveId}&export=download&confirm=t`;
    console.log(`[KMC-Media] Fetching ${asset.name} from Google Drive (${asset.driveId})...`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch ${asset.name}: HTTP ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    await import('node:fs/promises').then((fs) => fs.writeFile(primaryPath, buf));
  }

  for (const target of asset.paths.slice(1)) {
    if (!existsSync(target) && existsSync(primaryPath)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(primaryPath, target);
    }
  }
}

export async function bootstrapKmcAssets() {
  for (const item of OFFICIAL_ASSETS) {
    await ensureAsset(item);
  }
  console.log(`[KMC-Media] All ${OFFICIAL_ASSETS.length} official KMC & Nepal assets verified.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrapKmcAssets().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
