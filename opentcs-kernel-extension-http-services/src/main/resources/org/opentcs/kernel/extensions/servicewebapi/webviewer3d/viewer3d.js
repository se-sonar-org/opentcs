// SPDX-FileCopyrightText: The openTCS Authors
// SPDX-License-Identifier: MIT

// 3D fleet map viewer built on three.js.
//
// Data flow:
//  - GET /v1/plantModel  -> static layout (points, paths, locations), fetched once.
//  - GET /v1/vehicles    -> initial vehicle states, fetched once.
//  - GET /v1/sse?/events/vehicles=true -> live vehicle updates, streamed for the lifetime of the
//    page. The stream is read manually via fetch()/ReadableStream (instead of the EventSource
//    API) because EventSource cannot send the "X-Api-Access-Key" header the kernel's web API
//    requires when an access key is configured.
//
// Coordinate mapping (openTCS model millimeters -> three.js meters):
//   three.x =  model.x / 1000
//   three.y =  model.z / 1000   (height, usually 0)
//   three.z = -model.y / 1000
// A vehicle's orientationAngle (degrees, measured counter-clockwise around the model's Z axis,
// 0 pointing along +X) is applied as `rotation.y = degToRad(angle)`, which rotates a mesh's local
// +X axis to point at (cos, 0, -sin) in three.js space -- i.e. the same direction under the
// mapping above.

import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const MM_TO_M = 1 / 1000;
const SSE_EVENT_VEHICLES = '/events/vehicles';
const RECONNECT_DELAY_MS = 2000;
const POSE_SMOOTHING = 0.18;

const STATE_COLORS = {
  EXECUTING: 0x3ecf6a,
  CHARGING: 0x4f9dff,
  IDLE: 0x9aa3b2,
  UNAVAILABLE: 0xf5c542,
  ERROR: 0xef5757,
  UNKNOWN: 0x9aa3b2,
};

const dom = {
  viewport: document.getElementById('viewport'),
  baseUrlInput: document.getElementById('baseUrlInput'),
  accessKeyInput: document.getElementById('accessKeyInput'),
  connectButton: document.getElementById('connectButton'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  errorLine: document.getElementById('errorLine'),
  fleetCount: document.getElementById('fleetCount'),
  fleetEmpty: document.getElementById('fleetEmpty'),
  fleetList: document.getElementById('fleetList'),
  detailPanel: document.getElementById('detailPanel'),
  detailName: document.getElementById('detailName'),
  detailState: document.getElementById('detailState'),
  detailEnergy: document.getElementById('detailEnergy'),
  detailPosition: document.getElementById('detailPosition'),
  detailOrientation: document.getElementById('detailOrientation'),
  detailOrder: document.getElementById('detailOrder'),
};

const app = {
  baseUrl: '',
  accessKey: '',
  running: false,
  sseAbortController: null,
  points: new Map(),
  vehicles: new Map(),
  selectedVehicleName: null,
};

restoreSettings();
dom.connectButton.addEventListener('click', () => {
  persistSettings();
  connect();
});

// ---------------------------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------------------------

function restoreSettings() {
  dom.baseUrlInput.value = localStorage.getItem('opentcs.webviewer3d.baseUrl') || window.location.origin;
  dom.accessKeyInput.value = localStorage.getItem('opentcs.webviewer3d.accessKey') || '';
}

function persistSettings() {
  localStorage.setItem('opentcs.webviewer3d.baseUrl', dom.baseUrlInput.value.trim());
  localStorage.setItem('opentcs.webviewer3d.accessKey', dom.accessKeyInput.value);
}

// ---------------------------------------------------------------------------------------------
// HTTP / SSE helpers
// ---------------------------------------------------------------------------------------------

function requestHeaders(extra) {
  const headers = Object.assign({ Accept: 'application/json' }, extra);
  if (app.accessKey) {
    headers['X-Api-Access-Key'] = app.accessKey;
  }
  return headers;
}

async function fetchJson(path) {
  const response = await fetch(app.baseUrl + path, { headers: requestHeaders() });
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  return response.json();
}

function parseSseFrame(rawFrame) {
  let eventType = 'message';
  const dataLines = [];
  for (const line of rawFrame.split('\n')) {
    if (line.startsWith('event:')) {
      eventType = line.slice('event:'.length).trim();
    }
    else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  return dataLines.length === 0 ? null : { type: eventType, data: dataLines.join('\n') };
}

async function streamSse(path, onFrame, signal) {
  const url = `${app.baseUrl}${path}`;
  const response = await fetch(url, {
    headers: requestHeaders({ Accept: 'text/event-stream' }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`SSE connection failed: HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex;
    while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawFrame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const frame = parseSseFrame(rawFrame);
      if (frame) {
        onFrame(frame);
      }
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// three.js scene setup
// ---------------------------------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.05,
  5000
);
camera.position.set(15, 15, 15);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
dom.viewport.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;

scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const sunLight = new THREE.DirectionalLight(0xffffff, 0.9);
sunLight.position.set(20, 30, 10);
scene.add(sunLight);

const plantGroup = new THREE.Group();
scene.add(plantGroup);
const vehicleGroup = new THREE.Group();
scene.add(vehicleGroup);

let gridHelper = null;

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener('click', onCanvasClick);

function onCanvasClick(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(vehicleGroup.children, true);
  const hit = hits.find((h) => findVehicleName(h.object) !== null);
  selectVehicle(hit ? findVehicleName(hit.object) : null);
}

function findVehicleName(object3d) {
  let o = object3d;
  while (o) {
    if (o.userData && o.userData.vehicleName) {
      return o.userData.vehicleName;
    }
    o = o.parent;
  }
  return null;
}

layoutGroundAndCamera(new THREE.Box3());

(function animate() {
  requestAnimationFrame(animate);
  for (const vehicle of app.vehicles.values()) {
    if (!vehicle.mesh) {
      continue;
    }
    vehicle.mesh.position.lerp(vehicle.targetPosition, POSE_SMOOTHING);
    vehicle.mesh.quaternion.slerp(vehicle.targetQuaternion, POSE_SMOOTHING);
  }
  controls.update();
  renderer.render(scene, camera);
})();

// ---------------------------------------------------------------------------------------------
// Coordinate mapping
// ---------------------------------------------------------------------------------------------

function tripleToVector3(triple) {
  return new THREE.Vector3(
    triple.x * MM_TO_M,
    (triple.z || 0) * MM_TO_M,
    -triple.y * MM_TO_M
  );
}

function angleDegToQuaternion(angleDeg) {
  const quaternion = new THREE.Quaternion();
  if (Number.isFinite(angleDeg)) {
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(angleDeg));
  }
  return quaternion;
}

function segmentMesh(from, to, thickness, color) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  const geometry = new THREE.BoxGeometry(length, thickness, thickness);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const mesh = new THREE.Mesh(geometry, material);

  const midpoint = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  mesh.position.copy(midpoint);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(1, 0, 0),
    direction.clone().normalize()
  );
  return mesh;
}

// ---------------------------------------------------------------------------------------------
// Plant model
// ---------------------------------------------------------------------------------------------

async function loadPlantModel() {
  const plantModel = await fetchJson('/v1/plantModel');

  app.points.clear();
  while (plantGroup.children.length > 0) {
    plantGroup.remove(plantGroup.children[0]);
  }

  const bounds = new THREE.Box3();

  for (const point of plantModel.points) {
    const position = tripleToVector3(point.position);
    app.points.set(point.name, {
      position,
      vehicleOrientationAngle: point.vehicleOrientationAngle,
    });
    bounds.expandByPoint(position);

    const geometry = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 20);
    const color = point.type === 'PARK_POSITION' ? 0x6b7a99 : 0x39424f;
    const marker = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color }));
    marker.position.copy(position);
    plantGroup.add(marker);
  }

  for (const path of plantModel.paths) {
    const src = app.points.get(path.srcPointName);
    const dest = app.points.get(path.destPointName);
    if (!src || !dest) {
      continue;
    }
    const color = path.locked ? 0x5a3030 : 0x2c3340;
    plantGroup.add(segmentMesh(src.position, dest.position, 0.06, color));
  }

  for (const location of plantModel.locations || []) {
    const position = tripleToVector3(location.position);
    bounds.expandByPoint(position);
    const geometry = new THREE.OctahedronGeometry(0.2);
    const marker = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xd98a3d })
    );
    marker.position.copy(position);
    marker.position.y += 0.2;
    plantGroup.add(marker);
  }

  layoutGroundAndCamera(bounds);
}

function layoutGroundAndCamera(bounds) {
  if (gridHelper) {
    scene.remove(gridHelper);
    gridHelper.geometry.dispose();
    gridHelper.material.dispose();
  }

  let size = 20;
  let center = new THREE.Vector3(0, 0, 0);
  if (!bounds.isEmpty()) {
    const extent = new THREE.Vector3();
    bounds.getSize(extent);
    bounds.getCenter(center);
    size = Math.max(extent.x, extent.z, 5) * 1.6;
  }

  gridHelper = new THREE.GridHelper(size, 24, 0x3a4152, 0x22262f);
  gridHelper.position.set(center.x, -0.02, center.z);
  scene.add(gridHelper);

  controls.target.copy(center);
  camera.position.set(center.x + size * 0.6, size * 0.6, center.z + size * 0.6);
  camera.lookAt(center);
  controls.update();
}

// ---------------------------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------------------------

function normalizeVehicleFromRest(raw) {
  return {
    name: raw.name,
    boundingBox: raw.boundingBox,
    position: raw.precisePosition,
    orientationAngle: raw.orientationAngle,
    currentPosition: raw.currentPosition,
    state: raw.state,
    energyLevel: raw.energyLevel,
    transportOrder: raw.transportOrder,
  };
}

function normalizeVehicleFromSse(raw) {
  return {
    name: raw.name,
    boundingBox: raw.boundingBox,
    position: raw.pose ? raw.pose.position : null,
    orientationAngle: raw.pose ? raw.pose.orientationAngle : Number.NaN,
    currentPosition: raw.currentPosition,
    state: raw.state ? raw.state.state : 'UNKNOWN',
    energyLevel: raw.energyLevel,
    transportOrder: raw.transportOrder,
  };
}

function resolvePose(vehicle) {
  if (vehicle.position) {
    let angle = vehicle.orientationAngle;
    if (!Number.isFinite(angle) && vehicle.currentPosition) {
      const point = app.points.get(vehicle.currentPosition);
      angle = point ? point.vehicleOrientationAngle : Number.NaN;
    }
    return { position: tripleToVector3(vehicle.position), angleDeg: angle };
  }

  if (vehicle.currentPosition) {
    const point = app.points.get(vehicle.currentPosition);
    if (point) {
      return { position: point.position.clone(), angleDeg: point.vehicleOrientationAngle };
    }
  }

  return null;
}

function createVehicleMesh(vehicle) {
  const box = vehicle.boundingBox || { length: 1000, width: 1000, height: 1000 };
  const length = Math.max(box.length, 1) * MM_TO_M;
  const width = Math.max(box.width, 1) * MM_TO_M;
  const height = Math.max(box.height, 1) * MM_TO_M;

  const group = new THREE.Group();
  group.userData.vehicleName = vehicle.name;

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: STATE_COLORS[vehicle.state] || STATE_COLORS.UNKNOWN,
    roughness: 0.5,
    metalness: 0.15,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(length, height, width), bodyMaterial);
  body.position.y = height / 2;
  group.add(body);

  // A wedge on the +X face marks the vehicle's front (its reported orientation).
  const noseMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(width * 0.28, length * 0.35, 4),
    noseMaterial
  );
  nose.rotation.z = -Math.PI / 2;
  nose.rotation.y = Math.PI / 4;
  nose.position.set(length / 2, height / 2, 0);
  group.add(nose);

  const label = createLabelSprite(vehicle.name);
  label.position.y = height + 0.4;
  group.add(label);

  const highlight = new THREE.Mesh(
    new THREE.BoxGeometry(length * 1.25, height * 1.25, width * 1.25),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, wireframe: true })
  );
  highlight.position.y = height / 2;
  highlight.visible = false;
  group.add(highlight);

  vehicleGroup.add(group);

  return { group, body: bodyMaterial, highlight, label };
}

function createLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(15, 18, 22, 0.75)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 32px sans-serif';
  ctx.fillStyle = '#e6e9ef';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

function upsertVehicle(vehicle) {
  let entry = app.vehicles.get(vehicle.name);
  if (!entry) {
    const mesh = createVehicleMesh(vehicle);
    entry = {
      mesh: mesh.group,
      bodyMaterial: mesh.body,
      highlight: mesh.highlight,
      targetPosition: new THREE.Vector3(),
      targetQuaternion: new THREE.Quaternion(),
      data: vehicle,
    };
    app.vehicles.set(vehicle.name, entry);
  }
  entry.data = vehicle;

  const pose = resolvePose(vehicle);
  if (pose) {
    entry.targetPosition.copy(pose.position);
    entry.targetQuaternion.copy(angleDegToQuaternion(pose.angleDeg));
    if (!entry.placed) {
      entry.mesh.position.copy(pose.position);
      entry.mesh.quaternion.copy(entry.targetQuaternion);
      entry.placed = true;
    }
  }

  entry.bodyMaterial.color.setHex(STATE_COLORS[vehicle.state] || STATE_COLORS.UNKNOWN);

  renderFleetList();
  if (app.selectedVehicleName === vehicle.name) {
    renderDetailPanel(vehicle);
  }
}

function removeVehicle(name) {
  const entry = app.vehicles.get(name);
  if (!entry) {
    return;
  }
  vehicleGroup.remove(entry.mesh);
  app.vehicles.delete(name);
  if (app.selectedVehicleName === name) {
    selectVehicle(null);
  }
  renderFleetList();
}

function selectVehicle(name) {
  app.selectedVehicleName = name;
  for (const [vehicleName, entry] of app.vehicles) {
    entry.highlight.visible = vehicleName === name;
  }
  renderFleetList();

  if (!name) {
    dom.detailPanel.style.display = 'none';
    return;
  }
  const entry = app.vehicles.get(name);
  if (entry) {
    dom.detailPanel.style.display = 'block';
    renderDetailPanel(entry.data);
  }
}

// ---------------------------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------------------------

function renderFleetList() {
  const names = Array.from(app.vehicles.keys()).sort();
  dom.fleetCount.textContent = String(names.length);
  dom.fleetEmpty.style.display = names.length === 0 ? 'block' : 'none';
  dom.fleetList.innerHTML = '';

  for (const name of names) {
    const entry = app.vehicles.get(name);
    const li = document.createElement('li');
    li.className = name === app.selectedVehicleName ? 'selected' : '';

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = `#${(STATE_COLORS[entry.data.state] || STATE_COLORS.UNKNOWN).toString(16).padStart(6, '0')}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'name';
    nameSpan.textContent = name;

    const stateSpan = document.createElement('span');
    stateSpan.className = 'state';
    stateSpan.textContent = entry.data.state || '';

    li.append(swatch, nameSpan, stateSpan);
    li.addEventListener('click', () => selectVehicle(name));
    dom.fleetList.appendChild(li);
  }
}

function renderDetailPanel(vehicle) {
  dom.detailName.textContent = vehicle.name;
  dom.detailState.textContent = vehicle.state || 'UNKNOWN';
  dom.detailEnergy.textContent = Number.isFinite(vehicle.energyLevel) ? `${vehicle.energyLevel}%` : '–';
  dom.detailPosition.textContent = vehicle.currentPosition || '–';
  dom.detailOrientation.textContent = Number.isFinite(vehicle.orientationAngle)
    ? `${vehicle.orientationAngle.toFixed(1)}°`
    : '–';
  dom.detailOrder.textContent = vehicle.transportOrder || '–';
}

function setStatus(status, text) {
  dom.statusDot.className = `dot ${status}`;
  dom.statusText.textContent = text;
}

function showError(message) {
  dom.errorLine.textContent = message;
  dom.errorLine.style.display = message ? 'block' : 'none';
}

// ---------------------------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------------------------

async function connect() {
  if (app.sseAbortController) {
    app.sseAbortController.abort();
  }

  app.baseUrl = dom.baseUrlInput.value.trim().replace(/\/$/, '');
  app.accessKey = dom.accessKeyInput.value;
  app.running = true;
  showError('');
  setStatus('connecting', 'Loading plant model…');

  try {
    await loadPlantModel();
    await refreshVehicles();
  }
  catch (err) {
    setStatus('disconnected', 'Failed to load');
    showError(err.message);
    return;
  }

  runSseLoop();
}

async function refreshVehicles() {
  const vehicles = await fetchJson('/v1/vehicles');
  const seen = new Set();
  for (const raw of vehicles) {
    const vehicle = normalizeVehicleFromRest(raw);
    seen.add(vehicle.name);
    upsertVehicle(vehicle);
  }
  for (const name of Array.from(app.vehicles.keys())) {
    if (!seen.has(name)) {
      removeVehicle(name);
    }
  }
}

function handleVehicleSseFrame(frame) {
  if (frame.type !== SSE_EVENT_VEHICLES) {
    return;
  }
  let payload;
  try {
    payload = JSON.parse(frame.data);
  }
  catch (err) {
    console.warn('Could not parse SSE payload', err);
    return;
  }

  if (payload.currentObjectState) {
    upsertVehicle(normalizeVehicleFromSse(payload.currentObjectState));
  }
  else if (payload.previousObjectState) {
    removeVehicle(payload.previousObjectState.name);
  }
}

async function runSseLoop() {
  const query = `${encodeURIComponent(SSE_EVENT_VEHICLES)}=true`;
  while (app.running) {
    const controller = new AbortController();
    app.sseAbortController = controller;
    setStatus('connected', 'Live');
    showError('');

    try {
      await streamSse(`/v1/sse?${query}`, handleVehicleSseFrame, controller.signal);
    }
    catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      showError(`Live updates interrupted: ${err.message}`);
    }

    if (!app.running || controller.signal.aborted) {
      return;
    }

    setStatus('disconnected', 'Reconnecting…');
    await delay(RECONNECT_DELAY_MS);
    if (!app.running) {
      return;
    }
    try {
      // A full refresh closes any gap in vehicle state missed while disconnected.
      await refreshVehicles();
    }
    catch (err) {
      showError(err.message);
    }
  }
}
