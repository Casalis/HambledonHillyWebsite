// Photo album API for The Hambledon Hilly.
//
// Reads from the R2 bucket bound as PHOTOS (see wrangler.toml) and exposes:
//   GET /api/albums                      -> top-level "folders" in the bucket, e.g. ["2025/", "2026/"]
//   GET /api/albums?parent=2025/         -> folders inside one album, e.g. ["2025/20km/", "2025/10&5km/"]
//   GET /api/photos?album=2025/&cursor=  -> one page of photos in that folder, plus a cursor for the next page
//   GET /photo/<key>                     -> the image itself, streamed straight from R2
//
// The bucket stays private: only this Worker can read it, and it only ever serves images.

const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

const PAGE_SIZE = 48;
const THUMBS_FOLDER = 'thumbs/';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function extensionOf(key) {
  return key.split('.').pop().toLowerCase();
}

function isImage(key) {
  return extensionOf(key) in IMAGE_TYPES;
}

function photoPath(key) {
  return `/photo/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function json(data, maxAge = 60) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${maxAge}`,
    },
  });
}

function notFound() {
  return new Response('Not found', { status: 404, headers: CORS_HEADERS });
}

async function listAlbums(env, url) {
  // With ?parent=2025/ this lists that album's sub-albums (e.g. "2025/20km/").
  const parent = url.searchParams.get('parent') || '';
  const albums = [];
  let cursor;
  do {
    const page = await env.PHOTOS.list({ prefix: parent, delimiter: '/', cursor });
    albums.push(...page.delimitedPrefixes.filter(prefix => prefix !== parent + THUMBS_FOLDER));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ albums });
}

async function listPhotos(env, url) {
  const album = url.searchParams.get('album') || '';
  const cursor = url.searchParams.get('cursor') || undefined;

  const page = await env.PHOTOS.list({
    prefix: album,
    // Only list the album's own photos, not anything in nested sub-folders.
    delimiter: '/',
    cursor,
    limit: PAGE_SIZE,
  });

  // Thumbnails made by tools/resize_photos.py live in a "thumbs/" folder inside each album.
  const photos = page.objects
    .filter(obj => isImage(obj.key))
    .map(obj => {
      const name = obj.key.slice(album.length);
      return {
        key: obj.key,
        src: photoPath(obj.key),
        thumb: photoPath(`${album}${THUMBS_FOLDER}${name}`),
        size: obj.size,
        uploaded: obj.uploaded,
      };
    });

  return json({
    photos,
    cursor: page.truncated ? page.cursor : null,
  });
}

async function servePhoto(request, env, ctx, url) {
  const key = decodeURIComponent(url.pathname.slice('/photo/'.length));
  if (!key || !isImage(key)) return notFound();

  // Edge cache (effective on a custom domain; a no-op on workers.dev).
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const object = await env.PHOTOS.get(key);
  if (!object) return notFound();

  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', IMAGE_TYPES[extensionOf(key)]);
  }
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=86400');

  const response = new Response(request.method === 'HEAD' ? null : object.body, { headers });
  if (request.method === 'GET') {
    ctx.waitUntil(cache.put(request, response.clone()));
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/albums') return listAlbums(env, url);
    if (url.pathname === '/api/photos') return listPhotos(env, url);
    if (url.pathname.startsWith('/photo/')) return servePhoto(request, env, ctx, url);

    return notFound();
  },
};
