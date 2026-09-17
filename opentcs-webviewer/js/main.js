// SPDX-FileCopyrightText: The openTCS Authors
// SPDX-License-Identifier: MIT

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MM_PER_METER = 1000;
const VEHICLE_HEIGHT_M = 0.4;

const STATE_COLORS = {
  EXECUTING: 0x4caf50,
  CHARGING: 0x2196f3,
  IDLE: 0x9e9e9e,
  ERROR: 0xf44336,
  UNAVAILABLE: 0x616161,
  UNKNOWN: 0x9c27b0,
};

/**
 * Converts an openTCS plant model position (millimeters, Y axis pointing
 * "down" in the 2D layout) into Three.js scene coordinates (meters, Y axis
 * pointing up).
 */
function toSceneVector(triple) {
  return new THREE.Vector3(
    triple.x / MM_PER_METER,
    (triple.z || 0) / MM_PER_METER,
    -triple.y / MM_PER_METER
  );
}

function orientationToQuaternion(orientationAngleDeg) {
  const quaternion = new THREE.Quaternion();
  if (!Number.isFinite(orientationAngleDeg)) {
    return quaternion;
  }
  quaternion.setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    -THREE.MathUtils.degToRad(orientationAngleDeg)
  );
  return quaternion;
}

function makeLabelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '32px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
}

class SceneView {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1114);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    this.camera.position.set(15, 20, 25);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(30, 50, 10);
    this.scene.add(sun);

    this.plantGroup = new THREE.Group();
    this.scene.add(this.plantGroup);

    this.vehiclesGroup = new THREE.Group();
    this.scene.add(this.vehiclesGroup);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.renderer.setAnimationLoop(() => this.renderFrame());
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  renderFrame() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  clearPlant() {
    this.plantGroup.clear();
  }

  addPlantObject(object) {
    this.plantGroup.add(object);
  }

  focusOn(position) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    this.controls.target.copy(position);
    this.camera.position.copy(position).add(offset);
  }
}

class VehicleActor {
  constructor(scene, name) {
    this.name = name;
    this.group = new THREE.Group();

    this.bodyMaterial = new THREE.MeshStandardMaterial({ color: STATE_COLORS.UNKNOWN });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, VEHICLE_HEIGHT_M, 1.4), this.bodyMaterial);
    body.position.y = VEHICLE_HEIGHT_M / 2;
    this.group.add(body);

    const heading = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 0.5, 8),
      new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    heading.rotation.z = -Math.PI / 2;
    heading.position.set(0.8, VEHICLE_HEIGHT_M / 2, 0);
    this.group.add(heading);

    this.label = makeLabelSprite(name);
    this.label.position.set(0, VEHICLE_HEIGHT_M + 0.6, 0);
    this.group.add(this.label);

    scene.vehiclesGroup.add(this.group);

    this.fromPosition = new THREE.Vector3();
    this.toPosition = new THREE.Vector3();
    this.fromQuaternion = new THREE.Quaternion();
    this.toQuaternion = new THREE.Quaternion();
    this.transitionStart = 0;
    this.transitionEnd = 0;
    this.hasPose = false;
  }

  setTarget(position, quaternion, transitionDurationMs) {
    const now = performance.now();
    if (!this.hasPose) {
      this.group.position.copy(position);
      this.group.quaternion.copy(quaternion);
      this.hasPose = true;
    } else {
      this.getInterpolatedPose(now, this.fromPosition, this.fromQuaternion);
    }
    this.toPosition.copy(position);
    this.toQuaternion.copy(quaternion);
    this.transitionStart = now;
    this.transitionEnd = now + Math.max(transitionDurationMs, 1);
  }

  getInterpolatedPose(now, outPosition, outQuaternion) {
    const t = THREE.MathUtils.clamp(
      (now - this.transitionStart) / (this.transitionEnd - this.transitionStart),
      0,
      1
    );
    outPosition.copy(this.fromPosition).lerp(this.toPosition, t);
    outQuaternion.copy(this.fromQuaternion).slerp(this.toQuaternion, t);
  }

  update(now) {
    this.getInterpolatedPose(now, this.group.position, this.group.quaternion);
  }

  setColor(colorHex) {
    this.bodyMaterial.color.setHex(colorHex);
  }

  dispose(scene) {
    scene.vehiclesGroup.remove(this.group);
  }
}

class FleetClient {
  constructor(baseUrl, accessKey) {
    let trimmedUrl = baseUrl;
    while (trimmedUrl.endsWith('/')) {
      trimmedUrl = trimmedUrl.slice(0, -1);
    }
    this.baseUrl = trimmedUrl;
    this.accessKey = accessKey;
  }

  async getJson(path) {
    const headers = {};
    if (this.accessKey) {
      headers['X-Api-Access-Key'] = this.accessKey;
    }
    const response = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!response.ok) {
      throw new Error(`${path} -> HTTP ${response.status}`);
    }
    return response.json();
  }

  getPlantModel() {
    return this.getJson('/plantModel');
  }

  getVehicles() {
    return this.getJson('/vehicles');
  }
}

class FleetViewerApp {
  constructor() {
    this.sceneView = new SceneView(document.getElementById('scene-container'));
    this.statusEl = document.getElementById('connection-status');
    this.vehicleListEl = document.getElementById('vehicle-list');
    this.vehicleActors = new Map();
    this.pointPositions = new Map();
    this.pollTimer = null;

    document.getElementById('connect-button').addEventListener('click', () => this.connect());
  }

  setStatus(message) {
    this.statusEl.textContent = message;
  }

  async connect() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const baseUrl = document.getElementById('api-base-url').value.trim();
    const accessKey = document.getElementById('api-access-key').value;
    const pollIntervalMs = Math.max(
      100,
      Number(document.getElementById('poll-interval').value) || 1000
    );
    this.client = new FleetClient(baseUrl, accessKey);
    this.pollIntervalMs = pollIntervalMs;

    try {
      this.setStatus('Loading plant model...');
      await this.loadPlantModel();
      this.setStatus('Connected. Streaming vehicle positions...');
      await this.pollVehicles();
      this.pollTimer = setInterval(() => this.pollVehicles(), pollIntervalMs);
    } catch (error) {
      this.setStatus(`Connection failed: ${error.message}`);
    }
  }

  async loadPlantModel() {
    const plantModel = await this.client.getPlantModel();
    this.sceneView.clearPlant();
    this.pointPositions.clear();

    const grid = new THREE.GridHelper(200, 200, 0x2a2d33, 0x1c1e22);
    this.sceneView.addPlantObject(grid);

    const pointGeometry = new THREE.CylinderGeometry(0.15, 0.15, 0.05, 16);
    const pointMaterial = new THREE.MeshStandardMaterial({ color: 0x6f9bff });
    for (const point of plantModel.points || []) {
      const position = toSceneVector(point.position);
      this.pointPositions.set(point.name, position);

      const marker = new THREE.Mesh(pointGeometry, pointMaterial);
      marker.position.copy(position);
      this.sceneView.addPlantObject(marker);
    }

    const pathMaterial = new THREE.LineBasicMaterial({ color: 0x4a4f58 });
    for (const path of plantModel.paths || []) {
      const from = this.pointPositions.get(path.srcPointName);
      const to = this.pointPositions.get(path.destPointName);
      if (!from || !to) {
        continue;
      }
      const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
      this.sceneView.addPlantObject(new THREE.Line(geometry, pathMaterial));
    }

    this.frameCameraOnPoints();
  }

  frameCameraOnPoints() {
    if (this.pointPositions.size === 0) {
      return;
    }
    const box = new THREE.Box3();
    for (const position of this.pointPositions.values()) {
      box.expandByPoint(position);
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 20;
    this.sceneView.controls.target.copy(center);
    this.sceneView.camera.position.copy(center).add(
      new THREE.Vector3(size * 0.5, size * 0.6, size * 0.5)
    );
  }

  resolveVehiclePosition(vehicle) {
    if (vehicle.precisePosition) {
      return toSceneVector(vehicle.precisePosition);
    }
    if (vehicle.currentPosition && this.pointPositions.has(vehicle.currentPosition)) {
      return this.pointPositions.get(vehicle.currentPosition);
    }
    return null;
  }

  async pollVehicles() {
    let vehicles;
    try {
      vehicles = await this.client.getVehicles();
    } catch (error) {
      this.setStatus(`Update failed: ${error.message}`);
      return;
    }
    this.setStatus(`Connected. Last update: ${new Date().toLocaleTimeString()}`);

    const seenNames = new Set();
    for (const vehicle of vehicles) {
      const position = this.resolveVehiclePosition(vehicle);
      if (!position) {
        continue;
      }
      seenNames.add(vehicle.name);

      let actor = this.vehicleActors.get(vehicle.name);
      if (!actor) {
        actor = new VehicleActor(this.sceneView, vehicle.name);
        this.vehicleActors.set(vehicle.name, actor);
      }

      const quaternion = orientationToQuaternion(vehicle.orientationAngle);
      actor.setTarget(position, quaternion, this.pollIntervalMs);
      actor.setColor(STATE_COLORS[vehicle.state] ?? STATE_COLORS.UNKNOWN);
    }

    for (const [name, actor] of this.vehicleActors) {
      if (!seenNames.has(name)) {
        actor.dispose(this.sceneView);
        this.vehicleActors.delete(name);
      }
    }

    this.updateVehicleList(vehicles.filter((vehicle) => seenNames.has(vehicle.name)));
    this.animateVehicles();
  }

  updateVehicleList(vehicles) {
    this.vehicleListEl.innerHTML = '';
    for (const vehicle of vehicles) {
      const item = document.createElement('li');

      const dot = document.createElement('span');
      dot.className = 'vehicle-dot';
      dot.style.background = `#${(STATE_COLORS[vehicle.state] ?? STATE_COLORS.UNKNOWN).toString(16).padStart(6, '0')}`;

      const name = document.createElement('span');
      name.className = 'vehicle-name';
      name.textContent = vehicle.name;

      const meta = document.createElement('span');
      meta.className = 'vehicle-meta';
      meta.textContent = `${vehicle.state} · ${vehicle.energyLevel}%`;

      item.append(dot, name, meta);
      item.addEventListener('click', () => {
        const actor = this.vehicleActors.get(vehicle.name);
        if (actor) {
          this.sceneView.focusOn(actor.group.position);
        }
      });

      this.vehicleListEl.appendChild(item);
    }
  }

  animateVehicles() {
    const now = performance.now();
    for (const actor of this.vehicleActors.values()) {
      actor.update(now);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.fleetViewerApp = new FleetViewerApp();
});
