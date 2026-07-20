// Shrink the header logo out of the hero and into the compact bar on scroll
const header = document.querySelector('.site-header');
if (header) {
  const updateHeaderScrollState = () => {
    header.classList.toggle('is-scrolled', window.scrollY > 40);
  };
  window.addEventListener('scroll', updateHeaderScrollState, { passive: true });
  updateHeaderScrollState();
}

// Mobile nav toggle
const navToggle = document.querySelector('.nav-toggle');
if (navToggle) {
  navToggle.addEventListener('click', () => {
    const isOpen = header.classList.toggle('is-open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });
  document.querySelectorAll('.site-nav a').forEach(link => {
    link.addEventListener('click', () => {
      header.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// Route map
const ROUTE_COLORS = { '20k': '#16160f', '10k': '#a9840f', '5k': '#e0ba1a' };

// Race-day facts from the official event information (entry fees, start times,
// course descriptions). The 1k and 2k children's races run on footpaths within
// the vineyard estate and aren't published as GPS routes, so they render as a
// course description rather than a map line.
const COURSE_INFO = {
  '1k': {
    entryFee: '£5.00',
    startTime: '9.35am',
    description: 'Confined to footpaths and trails within the Hambledon Vineyard Estate. Well marshalled, and children may be accompanied by an adult at no extra cost. Timed, with trophies for first, second and third place boys and girls.',
  },
  '2k': {
    entryFee: '£5.00',
    startTime: '9.50am',
    description: 'Confined to footpaths and trails within the Hambledon Vineyard Estate. Well marshalled, and children may be accompanied by an adult at no extra cost. Timed, with trophies for first, second and third place boys and girls.',
  },
  '5k': {
    entryFee: '£13.00',
    startTime: '10.45am',
    description: 'Quiet lanes and beautiful trails through the heart of Hambledon village, with the last part on the estate. Well marked and marshalled, with trophies for first, second and third place men and women.',
  },
  '10k': {
    entryFee: '£18.00',
    startTime: '10.30am',
    description: 'Quiet lanes and beautiful trails through the heart of Hambledon village, with the last part on the estate, plus a water station halfway round. Well marked and marshalled, with trophies for first, second and third place men and women.',
  },
  '20k': {
    entryFee: '£20.00',
    startTime: '9.30am',
    description: 'A self-sufficient, self-navigated trail run for the trail purist. Course markings are sparse and marshals are only at busy road crossings. A mandatory kit list applies, including the route on a watch or phone, water and weather-appropriate gear. Trophies for first, second and third place men and women.',
  },
};

let routeMap;
let routeLine;
let startMarker;
let finishMarker;
let vineyardMarker;

function initRouteMap() {
  routeMap = L.map('route-map', { scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(routeMap);
}

function clearRouteLayers() {
  if (routeLine) { routeMap.removeLayer(routeLine); routeLine = null; }
  if (startMarker) { routeMap.removeLayer(startMarker); startMarker = null; }
  if (finishMarker) { routeMap.removeLayer(finishMarker); finishMarker = null; }
  if (vineyardMarker) { routeMap.removeLayer(vineyardMarker); vineyardMarker = null; }
}

function renderRoute(key) {
  const data = ROUTES[key];
  const info = COURSE_INFO[key];
  if (!info) return;

  if (!routeMap) initRouteMap();
  clearRouteLayers();

  if (data) {
    routeLine = L.polyline(data.points, {
      color: ROUTE_COLORS[key] || '#16160f',
      weight: 5,
      opacity: 0.9,
      lineJoin: 'round',
    }).addTo(routeMap);

    const first = data.points[0];
    const last = data.points[data.points.length - 1];

    startMarker = L.circleMarker(first, {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: '#16160f',
      fillOpacity: 1,
    }).addTo(routeMap).bindPopup('Start');

    finishMarker = L.circleMarker(last, {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: '#a9840f',
      fillOpacity: 1,
    }).addTo(routeMap).bindPopup('Finish');

    routeMap.fitBounds(data.bounds, { padding: [30, 30] });
  } else {
    // No published GPS route for this race: centre on race HQ within the vineyard.
    const raceHQ = ROUTES['5k'].points[0];
    vineyardMarker = L.circleMarker(raceHQ, {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: '#16160f',
      fillOpacity: 1,
    }).addTo(routeMap).bindPopup('Race HQ');
    routeMap.setView(raceHQ, 16);
  }

  const distanceCard = data
    ? `<div class="stat-card">
         <span class="stat-value">${data.distanceKm} km</span>
         <span class="stat-label">Route Distance</span>
       </div>
       <div class="stat-card">
         <span class="stat-value">${data.elevationGain} m</span>
         <span class="stat-label">Elevation Gain</span>
       </div>`
    : `<div class="stat-card">
         <span class="stat-value">${key}</span>
         <span class="stat-label">On-site vineyard route</span>
       </div>`;

  const statsEl = document.getElementById('route-stats');
  statsEl.innerHTML = `
    ${distanceCard}
    <div class="stat-card">
      <span class="stat-value">${info.startTime}</span>
      <span class="stat-label">Start Time</span>
    </div>
    <div class="stat-card">
      <span class="stat-value">${info.entryFee}</span>
      <span class="stat-label">Entry Fee</span>
    </div>
    <div class="stat-card stat-note">
      <span class="fact-label">Course</span>
      <p>${info.description}</p>
    </div>
  `;
}

function setActiveTab(key) {
  document.querySelectorAll('.route-tab').forEach(tab => {
    const isActive = tab.dataset.route === key;
    tab.classList.toggle('is-active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });
}

document.querySelectorAll('.route-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const key = tab.dataset.route;
    setActiveTab(key);
    renderRoute(key);
  });
});

if (document.getElementById('route-map')) {
  renderRoute('20k');
}

// Location map (centred on the 20k route bounds, i.e. the vineyard area)
const locationMapEl = document.getElementById('location-map');
if (locationMapEl && typeof ROUTES !== 'undefined') {
  const center = ROUTES['5k'].points[0];
  const locationMap = L.map('location-map', { scrollWheelZoom: false }).setView(center, 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(locationMap);
  L.marker(center).addTo(locationMap).bindPopup('Hambledon Vineyard — Race HQ').openPopup();
}
