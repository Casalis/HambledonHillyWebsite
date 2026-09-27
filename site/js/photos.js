// Photo album: streams photos from the R2 bucket via the hambledonhilly-photos Worker (see /worker).

// The deployed Worker's URL (no trailing slash). When the site is served
// locally, the local Worker from `npx wrangler dev` (port 8787) is used instead.
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const PHOTO_API = IS_LOCAL
  ? 'http://localhost:8787'
  : 'https://photos.hambledonhilly.com';

const albumGrid = document.getElementById('photo-album');
const albumTabs = document.getElementById('album-tabs');
const albumSubtabs = document.getElementById('album-subtabs');
const albumStatus = document.getElementById('album-status');
const albumSentinel = document.getElementById('album-sentinel');
const albumLightbox = document.getElementById('album-lightbox');
const albumLightboxImg = document.getElementById('album-lightbox-img');

let photos = [];
let currentAlbum = '';
let nextCursor = null;
let hasMore = true;
let isLoading = false;
// Incremented on album switch so responses for a previous album are ignored.
let loadGeneration = 0;
// Same idea for year switches, which first look up the year's distance folders.
let yearGeneration = 0;
let lightboxIndex = 0;

function setStatus(message) {
  albumStatus.textContent = message;
  albumStatus.hidden = !message;
}

// "2025/10&5km/" -> "10&5km" (the folder's own name, for tab labels).
function albumLabel(prefix) {
  return prefix.replace(/\/$/, '').split('/').pop().replace(/[-_]/g, ' ');
}

function addPhoto(photo) {
  const index = photos.length;
  photos.push(photo);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-thumb';

  const img = document.createElement('img');
  // Use the thumbnail if one was uploaded, otherwise fall back to the full photo.
  img.src = PHOTO_API + (photo.thumb || photo.src);
  img.addEventListener('error', () => {
    if (img.src !== PHOTO_API + photo.src) img.src = PHOTO_API + photo.src;
  });
  img.alt = `Hambledon Hilly ${currentAlbum.split('/').join(' ')} photo ${index + 1}`.replace(/\s+/g, ' ');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('load', () => button.classList.add('is-loaded'), { once: true });

  button.appendChild(img);
  button.addEventListener('click', () => openLightbox(index));
  albumGrid.appendChild(button);
}

async function loadNextPage() {
  if (isLoading || !hasMore) return;
  isLoading = true;
  const generation = loadGeneration;

  const params = new URLSearchParams({ album: currentAlbum });
  if (nextCursor) params.set('cursor', nextCursor);

  try {
    if (photos.length === 0) setStatus('Loading photos…');
    const res = await fetch(`${PHOTO_API}/api/photos?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (generation !== loadGeneration) return;

    data.photos.forEach(addPhoto);
    nextCursor = data.cursor;
    hasMore = Boolean(data.cursor);

    if (!hasMore && photos.length === 0) {
      setStatus('No photos in this album yet.');
    } else {
      setStatus('');
    }
  } catch (err) {
    if (generation !== loadGeneration) return;
    hasMore = false;
    setStatus('Sorry, the photos could not be loaded. Please try again later.');
    console.error('Photo album:', err);
  } finally {
    if (generation === loadGeneration) {
      isLoading = false;
      // Re-observing fires the observer again straight away if the sentinel is
      // still on screen, so short pages keep filling until the screen is full.
      if (hasMore) {
        sentinelObserver.unobserve(albumSentinel);
        sentinelObserver.observe(albumSentinel);
      }
    }
  }
}

const sentinelObserver = new IntersectionObserver(entries => {
  if (entries.some(entry => entry.isIntersecting)) loadNextPage();
}, { rootMargin: '800px 0px' });

function setActiveTab(container, prefix) {
  container.querySelectorAll('.route-tab').forEach(tab => {
    const isActive = tab.dataset.album === prefix;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
}

function renderTabs(container, prefixes, onSelect) {
  container.innerHTML = '';
  prefixes.forEach(prefix => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'route-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.album = prefix;
    tab.textContent = albumLabel(prefix);
    tab.addEventListener('click', () => onSelect(prefix));
    container.appendChild(tab);
  });
}

// Lists the folders inside `parent` ('' for the top level), sorted numerically
// descending: newest year first, then 20km, 10&5km, 1&2km.
async function fetchFolders(parent) {
  let folders = [];
  try {
    const params = new URLSearchParams({ parent });
    const res = await fetch(`${PHOTO_API}/api/albums?${params}`);
    if (res.ok) folders = (await res.json()).albums;
  } catch (err) {
    console.error('Photo album:', err);
  }
  return folders.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

function selectAlbum(prefix) {
  loadGeneration += 1;
  currentAlbum = prefix;
  photos = [];
  nextCursor = null;
  hasMore = true;
  isLoading = false;
  albumGrid.innerHTML = '';
  setActiveTab(albumSubtabs, prefix);

  sentinelObserver.unobserve(albumSentinel);
  sentinelObserver.observe(albumSentinel);
}

// Picks a year; if it is split into distance folders, shows those as a second row of tabs.
async function selectYear(prefix) {
  const generation = ++yearGeneration;
  loadGeneration += 1;
  setActiveTab(albumTabs, prefix);
  albumGrid.innerHTML = '';
  setStatus('Loading photos…');

  const distances = await fetchFolders(prefix);
  if (generation !== yearGeneration) return;

  renderTabs(albumSubtabs, distances, selectAlbum);
  albumSubtabs.hidden = distances.length === 0;
  selectAlbum(distances[0] || prefix);
}

async function initAlbums() {
  const years = await fetchFolders('');

  if (years.length > 1) {
    renderTabs(albumTabs, years, selectYear);
    albumTabs.hidden = false;
  }

  selectYear(years[0] || '');
}

// Lightbox
function showLightboxPhoto(index) {
  lightboxIndex = (index + photos.length) % photos.length;
  const img = albumGrid.children[lightboxIndex].querySelector('img');
  albumLightboxImg.src = PHOTO_API + photos[lightboxIndex].src;
  albumLightboxImg.alt = img.alt;
}

function openLightbox(index) {
  showLightboxPhoto(index);
  albumLightbox.showModal();
}

async function lightboxNext() {
  // At the end of what's loaded so far: fetch the next page rather than wrapping round.
  if (lightboxIndex === photos.length - 1 && hasMore) {
    await loadNextPage();
    if (lightboxIndex === photos.length - 1) return;
  }
  showLightboxPhoto(lightboxIndex + 1);
}

if (albumGrid && albumLightbox) {
  albumLightbox.querySelector('.lightbox-close').addEventListener('click', () => albumLightbox.close());
  albumLightbox.querySelector('.lightbox-prev').addEventListener('click', () => showLightboxPhoto(lightboxIndex - 1));
  albumLightbox.querySelector('.lightbox-next').addEventListener('click', lightboxNext);
  albumLightbox.addEventListener('click', (e) => {
    if (e.target === albumLightbox) albumLightbox.close();
  });
  albumLightbox.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') showLightboxPhoto(lightboxIndex - 1);
    if (e.key === 'ArrowRight') lightboxNext();
  });

  initAlbums();
}
