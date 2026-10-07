// Photo album API for The Hambledon Hilly.
//
// Reads from the R2 bucket bound as PHOTOS (see wrangler.toml) and exposes:
//   GET /api/albums                      -> top-level "folders" in the bucket, e.g. ["2025/", "2026/"]
//   GET /api/albums?parent=2025/         -> folders inside one album, e.g. ["2025/20km/", "2025/10&5km/"]
//   GET /api/photos?album=2025/&cursor=  -> one page of photos in that folder, plus a cursor for the next page
//   GET /api/random?count=18&album=2026/ -> a random selection of photos (album optional: whole bucket)
//   GET /photo/<key>                     -> the image itself, streamed straight from R2
//   GET /video/<key>                     -> a video from the "video/" folder, with Range support
//
// The bucket stays private: only this Worker can read it, and it only ever serves images
// and the highlights videos.

const IMAGE_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

const VIDEO_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const PAGE_SIZE = 48;
const THUMBS_FOLDER = 'thumbs/';
// Highlights videos (and their poster images) live here, kept out of the photo albums.
const VIDEO_FOLDER = 'video/';
const RANDOM_MAX = 50;
const KEY_LIST_TTL = 600;

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

// Thumbnails made by tools/resize_photos.py live in a "thumbs/" folder next to each photo:
// "2026/20km/12.jpg" -> "2026/20km/thumbs/12.jpg".
function thumbKey(key) {
  const slash = key.lastIndexOf('/') + 1;
  return key.slice(0, slash) + THUMBS_FOLDER + key.slice(slash);
}

function photoInfo(obj) {
  return {
    key: obj.key,
    src: photoPath(obj.key),
    thumb: photoPath(thumbKey(obj.key)),
  };
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
    albums.push(...page.delimitedPrefixes.filter(
      prefix => prefix !== parent + THUMBS_FOLDER && prefix !== VIDEO_FOLDER,
    ));
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

  const photos = page.objects
    .filter(obj => isImage(obj.key))
    .map(obj => ({ ...photoInfo(obj), size: obj.size, uploaded: obj.uploaded }));

  return json({
    photos,
    cursor: page.truncated ? page.cursor : null,
  });
}

// Every photo key in the bucket (not thumbnails). Listing the whole bucket takes one R2
// call per 1,000 objects, so the list is kept in the edge cache for a few minutes.
async function allPhotoKeys(env, ctx, url) {
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/__cache/all-photo-keys`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const keys = [];
  let cursor;
  do {
    const page = await env.PHOTOS.list({ cursor });
    for (const obj of page.objects) {
      if (isImage(obj.key) && !obj.key.split('/').includes('thumbs') && !obj.key.startsWith(VIDEO_FOLDER)) {
        keys.push(obj.key);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(keys), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${KEY_LIST_TTL}` },
  })));
  return keys;
}

async function randomPhotos(env, ctx, url) {
  const count = Math.min(Math.max(parseInt(url.searchParams.get('count'), 10) || 12, 1), RANDOM_MAX);
  // Optional ?album=2026/ limits the pick to one album (including its sub-albums).
  const album = url.searchParams.get('album') || '';
  const keys = (await allPhotoKeys(env, ctx, url)).filter(key => key.startsWith(album));

  // Partial Fisher-Yates shuffle: only the first `count` positions need to be random.
  const picks = Math.min(count, keys.length);
  for (let i = 0; i < picks; i++) {
    const j = i + Math.floor(Math.random() * (keys.length - i));
    [keys[i], keys[j]] = [keys[j], keys[i]];
  }

  // max-age=0 so each visit gets a fresh selection.
  return json({ photos: keys.slice(0, picks).map(key => photoInfo({ key })) }, 0);
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

// Videos are streamed with Range support so browsers (Safari/iOS in particular) can seek
// and start playback before the whole file has downloaded.
async function serveVideo(request, env, url) {
  const key = VIDEO_FOLDER + decodeURIComponent(url.pathname.slice('/video/'.length));
  const contentType = VIDEO_TYPES[extensionOf(key)];
  if (!contentType) return notFound();

  const object = await env.PHOTOS.get(key, { range: request.headers });
  if (!object) return notFound();

  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=86400');

  let status = 200;
  let length = object.size;
  if (object.range && request.headers.has('Range')) {
    const offset = object.range.offset ?? object.size - object.range.suffix;
    length = object.range.length ?? object.range.suffix ?? object.size - offset;
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    status = 206;
  }
  headers.set('Content-Length', String(length));

  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
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
    if (url.pathname === '/api/random') return randomPhotos(env, ctx, url);
    if (url.pathname.startsWith('/photo/')) return servePhoto(request, env, ctx, url);
    if (url.pathname.startsWith('/video/')) return serveVideo(request, env, url);

    return notFound();
  },
};
