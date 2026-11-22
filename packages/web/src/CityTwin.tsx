import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { api, type City, type Incident } from './api';
import { twinModel, type TwinModel } from './twinModel';

/**
 * The live 3D twin of a city, drawn as an architect's clay model: matte ivory buildings with soft ambient-occlusion
 * contact shadows (GTAO) and sun shadows, a calm street plan, soft trees and parks; the only colour is the data:
 * the real water network in emerald with water moving in it, a soft red glow where wards have no water, amber
 * where they are at risk, and every open incident as a pin (taller = more severe; grey = held, linked accounts). When outages in several zones
 * share one feeder, that pipe turns orange and the water stops past it: the same root cause the Neo4j query finds.
 *
 * focus: ward ids to zoom to; the rest of the town fades so the chosen wards read as their own map.
 * mode 'interactive' (officer): drag to orbit, scroll to zoom, click a pin to open the incident.
 */
export interface TwinProps { city?: City; incidents?: Incident[]; mode?: 'ambient' | 'interactive'; offset?: number; labels?: boolean; focus?: string[]; onPick?: (id: string) => void; onAsset?: (id: string) => void; onModel?: (m: TwinModel) => void }

const LEVEL: Record<string, number> = { CRITICAL: 0xdc2626, HIGH: 0xea580c, MEDIUM: 0xd97706, LOW: 0x059669 };
const HELD = 0x8a847b;
const WATER = 0x059669;
const SUSPECT = 0xea580c;
const FOG = 0xf2f0ea;
const CELL = 0.46; // one building plot; every 4th row/column is a street
const BLOCK = CELL * 4;
// clay model: near-white matte massing with the faintest warm/cool variation; soft sage trees and parks
const FACADES = [0xf7f5f0, 0xf2efe9, 0xeeeae2, 0xf4f1ea, 0xe9e5dc, 0xf6f3ec];
const HOUSES = [0xfbfaf7, 0xf7f5f0, 0xf9f7f2, 0xf4f1eb];
const LEAVES = [0xb3c2a3, 0xa7b897, 0xbccaae, 0x9fb08f];

function glowTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!; const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.7)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
/** One city block of ground: a plot, a thin kerb and a pale street around it (tiles across the town). */
function streetTexture(): THREE.Texture {
  const S = 256; const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  const road = Math.round((0.24 / BLOCK) * S / 2); // half the street width, in pixels, at each edge
  g.fillStyle = '#d9d3c7'; g.fillRect(0, 0, S, S); // plots
  g.fillStyle = '#cfc8bb'; // kerb
  g.fillRect(0, 0, S, road + 2); g.fillRect(0, S - road - 2, S, road + 2); g.fillRect(0, 0, road + 2, S); g.fillRect(S - road - 2, 0, road + 2, S);
  g.fillStyle = '#f3f1ec'; // street
  g.fillRect(0, 0, S, road); g.fillRect(0, S - road, S, road); g.fillRect(0, 0, road, S); g.fillRect(S - road, 0, road, S);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
/** A soft round glow (for wards without water / at risk): opaque centre fading to nothing. */
function softTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!; const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(0.55, 'rgba(255,255,255,0.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
function skyTexture(): THREE.Texture {
  const c = document.createElement('canvas'); c.width = 2; c.height = 256;
  const g = c.getContext('2d')!; const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, '#e3ece6'); grd.addColorStop(0.55, '#f0f0eb'); grd.addColorStop(1, '#f6f4ef');
  g.fillStyle = grd; g.fillRect(0, 0, 2, 256);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Facades get rows of windows (constant size whatever the building's height) and slightly darker flat roofs. */
function withWindows(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vLN;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 wp0 = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\nwp0 = instanceMatrix * wp0;\n#endif\nvWP = (modelMatrix * wp0).xyz;\nvLN = objectNormal;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP;\nvarying vec3 vLN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      if (abs(vLN.y) < 0.5 && vWP.y > 0.1) {
        float fy = fract(vWP.y / 0.13);
        float fx = fract((abs(vLN.x) > 0.5 ? vWP.z : vWP.x) / 0.1);
        float win = step(0.36, fy) * step(fy, 0.72) * step(0.24, fx) * step(fx, 0.76);
        diffuseColor.rgb *= 1.0 - win * 0.13; // the faintest window rows: scale, not texture
      }`);
  };
  return mat;
}

type Inst = { mesh: THREE.InstancedMesh; ward: Int16Array; base: Float32Array };

class TwinEngine {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
  private controls?: OrbitControls;
  private world = new THREE.Group();
  private city = new THREE.Group();
  private live = new THREE.Group();
  private glow = glowTexture();
  private streets = streetTexture();
  private soft = softTexture();
  private composer?: EffectComposer;
  private gtao?: GTAOPass;
  private sky = skyTexture();
  private flows: { curve: THREE.CurvePath<THREE.Vector3>; len: number; on: boolean }[] = [];
  private flowPts?: THREE.Points;
  private flowT: Float32Array = new Float32Array(0);
  private flowEdge: Int32Array = new Int32Array(0);
  private pulses: { mesh: THREE.Mesh; phase: number; grow: boolean; base: number }[] = [];
  private suspectMats: THREE.MeshStandardMaterial[] = [];
  private heads: { mesh: THREE.Object3D; y: number; phase: number }[] = [];
  private insts: Inst[] = [];
  private rims = new Map<string, THREE.MeshBasicMaterial>();
  private pickables: THREE.Object3D[] = [];
  private assetPicks: THREE.Object3D[] = [];
  private labelAnchors: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  private focusIds: string[] = [];
  private fly?: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; start: number };
  private raf = 0;
  private visible = true;
  private t = 0;
  private angle = 0.6;
  private mx = 0;
  private my = 0;
  private model?: TwinModel;
  private ro: ResizeObserver;
  private io: IntersectionObserver;
  private disposed = false;

  constructor(private host: HTMLElement, private overlay: HTMLElement, private o: { mode: 'ambient' | 'interactive'; offset: number; labels: boolean; onPick?: (id: string) => void; onAsset?: (id: string) => void; small: boolean; still: boolean }) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: o.small ? 'low-power' : 'high-performance' });
    this.renderer.setPixelRatio(Math.min(o.small ? 1.5 : 2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping; this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = !o.small; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    this.scene.background = this.sky;
    this.scene.fog = new THREE.Fog(FOG, 24, 62);
    this.scene.add(this.world);
    this.world.add(this.city, this.live);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd6d0c4, 1.7));
    const sun = new THREE.DirectionalLight(0xfff4e2, 2.1); sun.position.set(-14, 24, 11);
    sun.castShadow = !o.small; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 70 }); sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xf4efe4, 0.45); fill.position.set(12, 10, -14); this.scene.add(fill);
    this.camera.position.set(2, 13, 20.5);
    if (!o.small) { // soft contact shadows where buildings meet the ground and each other: the clay-model look
      const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
      this.composer = new EffectComposer(this.renderer, target);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      this.gtao.updateGtaoMaterial({ radius: 0.6, distanceFallOff: 1, thickness: 1.5, scale: 1.25, samples: 16 });
      this.gtao.blendIntensity = 0.9;
      this.composer.addPass(this.gtao);
      this.composer.addPass(new OutputPass());
    }

    if (o.mode === 'interactive') {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
      this.controls.maxPolarAngle = 1.3; this.controls.minDistance = 4; this.controls.maxDistance = 60;
      this.controls.autoRotate = !o.still; this.controls.autoRotateSpeed = 0.3;
      this.controls.addEventListener('start', () => { if (this.controls) this.controls.autoRotate = false; });
      this.renderer.domElement.addEventListener('pointerdown', this.press);
      this.renderer.domElement.addEventListener('pointerup', this.click);
      this.renderer.domElement.addEventListener('pointermove', this.hover);
    } else window.addEventListener('pointermove', this.parallax, { passive: true });

    this.ground();
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }); this.io.observe(host);
    this.resize();
    if (o.still) this.render(); else this.loop();
  }

  private ground() {
    const far = new THREE.Mesh(new THREE.CircleGeometry(120, 64), new THREE.MeshStandardMaterial({ color: 0xe2ddd2, roughness: 1 }));
    far.rotation.x = -Math.PI / 2; far.position.y = -0.02; far.receiveShadow = true; this.world.add(far);
    const n = 22; const size = BLOCK * n; // an even number of blocks keeps the streets on the building grid
    const tex = this.streets; tex.repeat.set(n, n);
    const town = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    town.rotation.x = -Math.PI / 2; town.position.y = -0.005; town.receiveShadow = true; this.world.add(town);
  }

  /** Builds the static town (wards, buildings, network) and the live layer (incidents). */
  setModel(m: TwinModel) {
    const sameCity = this.model && this.model.wards.map((w) => w.id + w.x.toFixed(2) + w.state).join() === m.wards.map((w) => w.id + w.x.toFixed(2) + w.state).join() && this.model.pipes.map((p) => p.state).join() === m.pipes.map((p) => p.state).join();
    const first = !this.model;
    this.model = m;
    if (!sameCity) this.buildCity(m);
    if (first && this.controls && !this.o.still) { // a short flight in from above when the page opens
      const p1 = this.camera.position.clone();
      this.camera.position.set(p1.x * 0.4, p1.y * 2.4, p1.z * 1.7);
      this.fly = { p0: this.camera.position.clone(), p1, t0: this.controls.target.clone(), t1: this.controls.target.clone(), start: performance.now() };
    }
    this.buildLive(m);
    this.applyFocus(false);
    if (this.o.still) this.render();
  }

  /** Zoom to these wards and fade the rest of the town; [] shows the whole town again. */
  setFocus(ids: string[]) {
    this.focusIds = ids;
    this.applyFocus(true);
  }

  private applyFocus(animate: boolean) {
    const m = this.model; if (!m) return;
    const sel = new Set(this.focusIds.filter((id) => m.wards.some((w) => w.id === id)));
    const idx = m.wards.map((w) => sel.size === 0 || sel.has(w.id));
    const fog = new THREE.Color(FOG); const c = new THREE.Color();
    for (const it of this.insts) {
      for (let i = 0; i < it.ward.length; i++) {
        c.setRGB(it.base[i * 3], it.base[i * 3 + 1], it.base[i * 3 + 2]);
        if (!(it.ward[i] < 0 ? sel.size === 0 : idx[it.ward[i]])) c.lerp(fog, 0.7);
        it.mesh.setColorAt(i, c);
      }
      if (it.mesh.instanceColor) it.mesh.instanceColor.needsUpdate = true;
    }
    m.wards.forEach((w) => { const r = this.rims.get(w.id); if (r) { r.opacity = sel.has(w.id) ? 0.95 : sel.size ? 0.12 : 0.4; r.color.set(sel.has(w.id) ? 0x047857 : 0x5f8f7c); } });
    this.placeLabels(m);
    if (!this.controls || !animate) return;
    const chosen = m.wards.filter((w) => sel.has(w.id));
    const t1 = new THREE.Vector3(); let dist = 30;
    if (chosen.length) {
      chosen.forEach((w) => t1.add(new THREE.Vector3(w.x, 0, w.z))); t1.divideScalar(chosen.length);
      const reach = Math.max(...chosen.map((w) => Math.hypot(w.x - t1.x, w.z - t1.z) + w.r * 1.2));
      dist = Math.min(44, Math.max(7, reach * 2.6 + 3));
    }
    const dir = this.camera.position.clone().sub(this.controls.target); dir.y = 0;
    if (dir.lengthSq() < 0.01) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(Math.cos(0.9)); dir.y = Math.sin(0.9);
    this.controls.autoRotate = false;
    this.fly = { p0: this.camera.position.clone(), p1: t1.clone().add(dir.multiplyScalar(dist)), t0: this.controls.target.clone(), t1, start: performance.now() };
    if (this.o.still) { this.camera.position.copy(this.fly.p1); this.controls.target.copy(t1); this.fly = undefined; this.controls.update(); this.render(); }
  }

  private clear(g: THREE.Group) {
    g.traverse((x) => { const mesh = x as THREE.Mesh; mesh.geometry?.dispose?.(); const mat = mesh.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((mm) => mm.dispose()); });
    g.clear();
  }

  private buildCity(m: TwinModel) {
    this.clear(this.city);
    this.flows = []; this.assetPicks = []; this.suspectMats = []; this.pulses = this.pulses.filter((p) => this.liveSet.has(p.mesh)); this.insts = []; this.rims.clear();
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    // ward outlines on the ground; a light red wash where the water failed, amber where it is at risk
    for (const w of m.wards) {
      if (w.state !== 'ok') {
        const fill = new THREE.Mesh(new THREE.PlaneGeometry(w.r * 2.9, w.r * 2.9), new THREE.MeshBasicMaterial({ color: w.state === 'hit' ? 0xef4444 : 0xf59e0b, map: this.soft, transparent: true, opacity: w.state === 'hit' ? 0.42 : 0.38, depthWrite: false }));
        fill.rotation.x = -Math.PI / 2; fill.position.set(w.x, 0.015, w.z); fill.renderOrder = 1; this.city.add(fill);
        if (w.state === 'hit') this.pulses.push({ mesh: fill, phase: rnd(), grow: false, base: 0.42 });
      }
      const rm = new THREE.MeshBasicMaterial({ color: 0x5f8f7c, transparent: true, opacity: 0.4, depthWrite: false });
      const rim = new THREE.Mesh(new THREE.RingGeometry(w.r * 1.15 - 0.035, w.r * 1.15, 128), rm);
      rim.rotation.x = -Math.PI / 2; rim.position.set(w.x, 0.02, w.z); this.city.add(rim); this.rims.set(w.id, rm);
    }

    // plots on one town-wide grid: dense blocks inside wards (taller towards the centre), houses and trees between
    const near = (x: number, z: number) => { let best = -1; let bd = Infinity; m.wards.forEach((w, i) => { const d = Math.hypot(x - w.x, z - w.z) / w.r; if (d < bd) { bd = d; best = i; } }); return { i: best, d: bd }; };
    const clearOf = (x: number, z: number) => m.assets.every((a) => Math.hypot(x - a.x, z - a.z) > (a.kind === 'PIPE' ? 0.35 : 0.9));
    const blocks: { x: number; z: number; w: number; d: number; h: number; c: number; ward: number }[] = [];
    const houses: typeof blocks = [];
    const trees: { x: number; z: number; s: number; c: number; ward: number }[] = [];
    const reachTown = m.span + 2.5;
    const n = Math.ceil(reachTown / CELL);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      if (i % 4 === 0 || j % 4 === 0) continue; // streets
      const x = i * CELL; const z = j * CELL;
      if (Math.hypot(x, z) > reachTown || !clearOf(x, z)) continue;
      const nw = near(x, z); const w = m.wards[nw.i];
      const r = rnd();
      if (w && nw.d < 1) {
        const dc = Math.hypot(x - w.x, z - w.z);
        if (dc < 0.45 || r < 0.14) continue;
        const centre = Math.max(0, 1 - Math.hypot(x, z) / (m.span * 1.1));
        const h = 0.24 + Math.pow(rnd(), 2.1) * (0.9 + 3.2 * centre) * (1 - dc / (w.r * 1.5));
        if (h < 0.34 && rnd() < 0.45) houses.push({ x, z, w: 0.32 + rnd() * 0.06, d: 0.3 + rnd() * 0.06, h: 0.17 + rnd() * 0.08, c: rnd(), ward: nw.i });
        else blocks.push({ x, z, w: 0.3 + rnd() * 0.08, d: 0.3 + rnd() * 0.08, h, c: rnd(), ward: nw.i });
      } else if (nw.d < 1.9) {
        if (r < 0.55) houses.push({ x, z, w: 0.3 + rnd() * 0.07, d: 0.28 + rnd() * 0.07, h: 0.16 + rnd() * 0.1, c: rnd(), ward: nw.d < 1.25 ? nw.i : -1 });
        else if (r < 0.66) for (let k = 0; k < 3; k++) trees.push({ x: x + (rnd() - 0.5) * 0.26, z: z + (rnd() - 0.5) * 0.26, s: 0.08 + rnd() * 0.05, c: rnd(), ward: nw.d < 1.25 ? nw.i : -1 });
      } else if (r < 0.2) houses.push({ x, z, w: 0.28 + rnd() * 0.07, d: 0.26 + rnd() * 0.07, h: 0.15 + rnd() * 0.08, c: rnd(), ward: -1 });
      else if (r < 0.26 && rnd() < 0.5) for (let k = 0; k < 3; k++) trees.push({ x: x + (rnd() - 0.5) * 0.26, z: z + (rnd() - 0.5) * 0.26, s: 0.08 + rnd() * 0.04, c: rnd(), ward: -1 });
    }
    // street trees along the avenues inside wards
    for (const b of blocks) if (rnd() < 0.14) trees.push({ x: b.x + (rnd() < 0.5 ? -1 : 1) * CELL * 0.5, z: b.z + (rnd() - 0.5) * 0.3, s: 0.06 + rnd() * 0.025, c: rnd(), ward: b.ward });

    const shadows = !this.o.small;
    const make = (geo: THREE.BufferGeometry, mat: THREE.Material, list: { ward: number }[], place: (i: number, mm: THREE.Matrix4, c: THREE.Color) => void) => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length)); mesh.count = list.length;
      mesh.castShadow = shadows; mesh.receiveShadow = shadows;
      const mm = new THREE.Matrix4(); const c = new THREE.Color(); const base = new Float32Array(list.length * 3); const ward = new Int16Array(list.length);
      list.forEach((it, i) => { place(i, mm, c); mesh.setMatrixAt(i, mm); mesh.setColorAt(i, c); base.set([c.r, c.g, c.b], i * 3); ward[i] = it.ward; });
      this.city.add(mesh); this.insts.push({ mesh, ward, base });
    };
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    make(box, withWindows(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 })), blocks, (i, mm, c) => { const b = blocks[i]; mm.makeScale(b.w, b.h, b.d).setPosition(b.x, 0, b.z); c.setHex(FACADES[Math.floor(b.c * FACADES.length)]); });
    make(box.clone(), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), houses, (i, mm, c) => { const b = houses[i]; mm.makeScale(b.w, b.h, b.d).setPosition(b.x, 0, b.z); c.setHex(HOUSES[Math.floor(b.c * HOUSES.length)]); });
    const crown = new THREE.IcosahedronGeometry(1, 2); crown.scale(1, 1.1, 1);
    make(crown, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), trees, (i, mm, c) => { const t = trees[i]; mm.makeScale(t.s, t.s, t.s).setPosition(t.x, t.s * 1.1 + 0.05, t.z); c.setHex(LEAVES[Math.floor(t.c * LEAVES.length)]); });

    // water network: emerald pipes along the streets with water moving in them
    for (const p of m.pipes) {
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 0; i < p.pts.length - 1; i++) {
        const a = new THREE.Vector3(p.pts[i][0], 0.07, p.pts[i][1]); const b = new THREE.Vector3(p.pts[i + 1][0], 0.07, p.pts[i + 1][1]);
        if (a.distanceTo(b) > 0.01) path.add(new THREE.LineCurve3(a, b));
      }
      if (path.curves.length === 0) continue;
      const color = p.state === 'suspect' ? SUSPECT : p.state === 'dry' ? 0xa8a29e : WATER;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05, emissive: color, emissiveIntensity: p.state === 'dry' ? 0 : 0.45 });
      const tube = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, path.curves.length * 12), p.state === 'suspect' ? 0.075 : 0.05, 8, false), mat);
      this.city.add(tube);
      const grab = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, path.curves.length * 6), 0.22, 6, false), new THREE.MeshBasicMaterial({ visible: false })); // easy to click
      grab.userData.asset = p.from; this.city.add(grab); this.assetPicks.push(grab);
      if (p.state === 'suspect') this.suspectMats.push(mat);
      this.flows.push({ curve: path, len: path.getLength(), on: p.state === 'flow' });
    }
    const live = this.flows.filter((f) => f.on);
    const per = this.o.small ? 3 : 6;
    const count = live.reduce((acc, f) => acc + Math.max(2, Math.round(f.len * per / 6)), 0);
    this.flowT = new Float32Array(count); this.flowEdge = new Int32Array(count);
    let k = 0;
    live.forEach((f) => { const cnt = Math.max(2, Math.round(f.len * per / 6)); for (let i = 0; i < cnt; i++, k++) { this.flowT[k] = i / cnt; this.flowEdge[k] = this.flows.indexOf(f); } });
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.flowPts = new THREE.Points(fg, new THREE.PointsMaterial({ size: 0.26, map: this.glow, color: 0x6ee7b7, transparent: true, depthWrite: false }));
    this.city.add(this.flowPts);

    // network assets: the overhead tank on legs, the pump house, junctions; the suspect feeder pulses orange
    for (const a of m.assets) {
      const g = new THREE.Group(); g.position.set(a.x, 0, a.z);
      const cast = (o: THREE.Mesh) => { o.castShadow = shadows; o.receiveShadow = shadows; g.add(o); return o; };
      if (a.kind === 'TANK') {
        const concrete = new THREE.MeshStandardMaterial({ color: 0xe4e0d8, roughness: 0.9 });
        for (const [dx, dz] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]]) cast(new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.2, 0.09), concrete)).position.set(dx, 1.1, dz);
        cast(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.2, 10), concrete)).position.y = 1.1;
        cast(new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.5, 0.85, 28), new THREE.MeshStandardMaterial({ color: 0xf6f4ef, roughness: 0.8 }))).position.y = 2.62;
        cast(new THREE.Mesh(new THREE.ConeGeometry(0.7, 0.22, 28), new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.85 }))).position.y = 3.16;
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.665, 0.64, 0.12, 28), new THREE.MeshStandardMaterial({ color: WATER, roughness: 0.5 })); band.position.y = 2.5; g.add(band);
      } else if (a.kind === 'PUMP') {
        cast(new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.48, 0.62), new THREE.MeshStandardMaterial({ color: 0xf1eee8, roughness: 0.9 }))).position.y = 0.24;
        const r = cast(new THREE.Mesh(new THREE.ConeGeometry(0.66, 0.24, 4), new THREE.MeshStandardMaterial({ color: 0xe2ddd3, roughness: 0.85, flatShading: true }))); r.rotation.y = Math.PI / 4; r.scale.set(1, 1, 0.78); r.position.y = 0.6;
        const door = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.02), new THREE.MeshStandardMaterial({ color: WATER })); door.position.set(0, 0.15, 0.32); g.add(door);
      } else {
        const mat = new THREE.MeshStandardMaterial({ color: a.suspect ? SUSPECT : 0x047857, roughness: 0.5, emissive: a.suspect ? SUSPECT : 0x000000, emissiveIntensity: 0.3 });
        cast(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.22, 16), mat)).position.y = 0.11;
        if (a.suspect) this.suspectMats.push(mat);
      }
      const grab = new THREE.Mesh(new THREE.CylinderGeometry(a.kind === 'PIPE' ? 0.4 : 0.8, a.kind === 'PIPE' ? 0.4 : 0.8, a.kind === 'TANK' ? 3.4 : 0.9, 10), new THREE.MeshBasicMaterial({ visible: false }));
      grab.position.y = a.kind === 'TANK' ? 1.7 : 0.45; grab.userData.asset = a.id; g.add(grab); this.assetPicks.push(grab);
      if (a.suspect) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 48), new THREE.MeshBasicMaterial({ color: SUSPECT, transparent: true, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.04; g.add(ring);
        this.pulses.push({ mesh: ring, phase: 0, grow: true, base: 0.9 });
      }
      this.city.add(g);
    }
  }

  private buildLive(m: TwinModel) {
    this.clear(this.live);
    this.pulses = this.pulses.filter((p) => !this.liveSet.has(p.mesh));
    this.liveSet.clear(); this.heads = [];
    this.pickables = [];
    const pole = new THREE.MeshStandardMaterial({ color: 0x57534e, roughness: 0.6 });
    for (const b of m.beacons.slice(0, 40)) {
      const color = b.held ? HELD : LEVEL[b.level] ?? LEVEL.LOW;
      const h = b.held ? 0.9 : 1.05 + (b.score / 100) * 2.2;
      const g = new THREE.Group(); g.position.set(b.x, 0, b.z); g.userData.id = b.id;
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, h, 6), pole); stick.position.y = h / 2; stick.castShadow = true; g.add(stick);
      const head = new THREE.Group(); head.position.y = h;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(b.held ? 0.15 : 0.2, 24, 16), new THREE.MeshStandardMaterial({ color, roughness: 0.35, emissive: color, emissiveIntensity: 0.25 })); ball.castShadow = true; head.add(ball);
      const dot = new THREE.Mesh(new THREE.SphereGeometry(b.held ? 0.06 : 0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })); dot.position.set(0, 0, b.held ? 0.12 : 0.16); head.add(dot);
      g.add(head); this.heads.push({ mesh: head, y: h, phase: (this.heads.length * 0.9) % 6 });
      const foot = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), new THREE.MeshBasicMaterial({ color: 0x1c1917, transparent: true, opacity: 0.18, depthWrite: false })); foot.rotation.x = -Math.PI / 2; foot.position.y = 0.025; g.add(foot);
      if (!b.held) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 40), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; g.add(ring);
        this.pulses.push({ mesh: ring, phase: (this.pulses.length * 0.37) % 1, grow: true, base: 0.85 }); this.liveSet.add(ring);
      } else { // a dashed fence around a held crowd
        const fence = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 48 }, (_, i) => new THREE.Vector3(Math.cos((i / 48) * Math.PI * 2) * 0.7, 0.04, Math.sin((i / 48) * Math.PI * 2) * 0.7))), new THREE.LineDashedMaterial({ color: 0x78716c, dashSize: 0.1, gapSize: 0.08 }));
        fence.computeLineDistances(); g.add(fence);
      }
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, h + 0.3, 8), new THREE.MeshBasicMaterial({ visible: false })); hit.position.y = (h + 0.3) / 2; hit.userData.id = b.id; g.add(hit); this.pickables.push(hit);
      this.live.add(g);
    }
    this.placeLabels(m);
  }
  private liveSet = new Set<THREE.Object3D>();

  private placeLabels(m: TwinModel) {
    this.overlay.innerHTML = '';
    this.labelAnchors = [];
    if (!this.o.labels) return;
    const add = (html: string, cls: string, pos: THREE.Vector3) => { const el = document.createElement('div'); el.className = `twin-label ${cls}`; el.innerHTML = html; this.overlay.appendChild(el); this.labelAnchors.push({ el, pos }); };
    const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
    const sel = new Set(this.focusIds);
    const inFocus = (ward?: string) => sel.size === 0 || m.wards.some((w) => sel.has(w.id) && w.name === ward);
    if (sel.size) {
      for (const w of m.wards.filter((x) => sel.has(x.id))) {
        const st = w.state === 'hit' ? 'No water' : w.state === 'risk' ? 'At risk' : 'Water normal';
        add(`<b>${esc(w.name)}</b><span>${st} · ${m.beacons.filter((b) => b.ward === w.name).length} open</span>`, `ward ${w.state}`, new THREE.Vector3(w.x, 0.1, w.z - w.r * 1.15));
      }
    }
    if (m.suspect && sel.size === 0) add(`<b>${esc(m.suspect.name)}</b><span>Likely failure point · traced on the graph</span>`, 'suspect', new THREE.Vector3(m.suspect.x, 0.4, m.suspect.z));
    const top = sel.size ? undefined : m.beacons.find((b) => !b.held && inFocus(b.ward));
    if (top) add(`<b>${esc(top.ward ?? '')} · ${esc(top.what)}</b><span>${top.reports} reports · ${top.people} independent people</span>`, `lvl-${top.level}`, new THREE.Vector3(top.x, 1.05 + (top.score / 100) * 2.2 + 0.25, top.z));
    const held = sel.size ? undefined : m.beacons.find((b) => b.held && inFocus(b.ward));
    if (held) add(`<b>Held · ${held.reports} reports</b><span>${held.people === 1 ? 'one real source' : `${held.people} real sources`} · linked accounts</span>`, 'held', new THREE.Vector3(held.x, 1.15, held.z));
    const tank = m.assets.find((a) => a.kind === 'TANK');
    if (tank && !this.o.small && sel.size === 0) add(`<b>${esc(tank.name)}</b><span>water network from the city's map</span>`, 'tank', new THREE.Vector3(tank.x, 3.3, tank.z));
  }

  private resize() {
    const w = this.host.clientWidth || 1; const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    const pr = this.renderer.getPixelRatio();
    this.composer?.setSize(w, h); this.composer?.setPixelRatio(pr);
    this.camera.aspect = w / h;
    this.camera.fov = w < 700 ? 52 : 40;
    this.world.position.x = w > 1000 ? this.o.offset : 0;
    this.camera.updateProjectionMatrix();
    if (this.o.still) this.render();
  }

  private parallax = (e: PointerEvent) => { this.mx = (e.clientX / window.innerWidth - 0.5) * 2; this.my = (e.clientY / window.innerHeight - 0.5) * 2; };
  private ray = new THREE.Raycaster();
  private ndc(e: PointerEvent) { const r = this.renderer.domElement.getBoundingClientRect(); return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
  private pickAt(e: PointerEvent): string | undefined { this.ray.setFromCamera(this.ndc(e), this.camera); return this.ray.intersectObjects(this.pickables, false)[0]?.object.userData.id as string | undefined; }
  private assetAt(e: PointerEvent): string | undefined { this.ray.setFromCamera(this.ndc(e), this.camera); return this.ray.intersectObjects(this.assetPicks, false)[0]?.object.userData.asset as string | undefined; }
  private down = { x: 0, y: 0 };
  private press = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY }; };
  private dragged = (e: PointerEvent) => e.buttons > 0 && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6;
  private click = (e: PointerEvent) => { if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) return; const id = this.pickAt(e); if (id) { this.o.onPick?.(id); return; } const a = this.o.onAsset ? this.assetAt(e) : undefined; if (a) this.o.onAsset!(a); };
  private hover = (e: PointerEvent) => { if (this.fly && this.dragged(e)) this.fly = undefined; // a real drag takes over from a camera flight
    this.renderer.domElement.style.cursor = this.pickAt(e) || (this.o.onAsset && this.assetAt(e)) ? 'pointer' : 'grab'; };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.visible || document.hidden) return;
    this.t += 1;
    this.step();
    this.render();
  };

  private step() {
    const t = this.t;
    if (this.fly && this.controls) {
      const f = this.fly; const k = Math.min(1, (performance.now() - f.start) / 900); // time-based: same speed on slow machines
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      this.camera.position.lerpVectors(f.p0, f.p1, e); this.controls.target.lerpVectors(f.t0, f.t1, e);
      if (k >= 1) this.fly = undefined;
    }
    if (this.controls) this.controls.update();
    else {
      this.angle += 0.0009;
      const w = this.host.clientWidth;
      const r = w < 520 ? 21 : 29;
      this.camera.position.set(Math.sin(this.angle) * r + this.mx * 2.5, (w < 520 ? 12 : 15) - this.my * 2.5, Math.cos(this.angle) * r);
      this.camera.lookAt(this.world.position.x * 0.35, 0.8, 0);
    }
    if (this.flowPts) {
      const pos = this.flowPts.geometry.getAttribute('position') as THREE.BufferAttribute;
      const v = new THREE.Vector3();
      for (let i = 0; i < this.flowT.length; i++) {
        const f = this.flows[this.flowEdge[i]];
        this.flowT[i] = (this.flowT[i] + 0.9 / (60 * Math.max(1, f.len))) % 1;
        f.curve.getPointAt(this.flowT[i], v); pos.setXYZ(i, v.x, v.y + 0.03, v.z);
      }
      pos.needsUpdate = true;
    }
    for (const p of this.pulses) {
      const k = (t * 0.01 + p.phase) % 1; const mat = p.mesh.material as THREE.MeshBasicMaterial;
      if (p.grow) { p.mesh.scale.setScalar(1 + k * 2.4); mat.opacity = p.base * (1 - k); }
      else mat.opacity = p.base * (0.6 + 0.4 * Math.sin((t * 0.04) + p.phase * 6));
    }
    for (const h of this.heads) h.mesh.position.y = h.y + Math.sin(t * 0.05 + h.phase) * 0.05;
    const s = 0.5 + 0.5 * Math.sin(t * 0.08);
    for (const m of this.suspectMats) m.emissiveIntensity = 0.15 + 0.6 * s;
  }

  private render() {
    if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
    if (this.labelAnchors.length) {
      const w = this.host.clientWidth; const h = this.host.clientHeight; const v = new THREE.Vector3();
      for (const a of this.labelAnchors) {
        v.copy(a.pos).add(this.world.position).project(this.camera);
        const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
        a.el.style.opacity = on ? '1' : '0';
        a.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, calc(-100% - 14px))`;
      }
    }
  }

  dispose() {
    if (this.disposed) return; this.disposed = true;
    cancelAnimationFrame(this.raf); this.ro.disconnect(); this.io.disconnect();
    window.removeEventListener('pointermove', this.parallax);
    this.controls?.dispose();
    this.clear(this.city); this.clear(this.live); this.clear(this.world);
    [this.glow, this.streets, this.sky, this.soft].forEach((x) => x.dispose());
    this.composer?.dispose(); this.gtao?.dispose();
    this.renderer.dispose(); this.renderer.domElement.remove();
    this.overlay.innerHTML = '';
  }
}

export default function CityTwin({ city, incidents, mode = 'ambient', offset = 0, labels = true, focus, onPick, onAsset, onModel }: TwinProps) {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const engine = useRef<TwinEngine>();
  const pick = useRef(onPick); pick.current = onPick;
  const asset = useRef(onAsset); asset.current = onAsset;
  const lastSig = useRef('');
  const [own, setOwn] = useState<{ city?: City; incidents: Incident[] }>({ incidents: [] });
  const [failed, setFailed] = useState(false);

  // load the current city ourselves when the caller did not pass data
  useEffect(() => {
    if (city) return;
    let stop = false;
    const load = () => Promise.all([api.city(), api.incidents()]).then(([c, i]) => { if (!stop) setOwn({ city: c, incidents: i }); }).catch(() => undefined);
    void load(); const h = setInterval(load, 20_000);
    return () => { stop = true; clearInterval(h); };
  }, [city]);

  useEffect(() => {
    if (!host.current || !overlay.current) return;
    if (typeof WebGLRenderingContext === 'undefined') { setFailed(true); return; }
    try {
      const small = Math.min(window.innerWidth, window.innerHeight) < 600 || (navigator.hardwareConcurrency ?? 8) <= 4;
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      engine.current = new TwinEngine(host.current, overlay.current, { mode, offset, labels, small, still, onPick: (id) => pick.current?.(id), onAsset: (id) => asset.current?.(id) });
    } catch { setFailed(true); }
    return () => { engine.current?.dispose(); engine.current = undefined; };
  }, [mode, offset, labels]);

  const c = city ?? own.city;
  const inc = incidents ?? own.incidents;
  useEffect(() => {
    if (!c || !engine.current) return;
    const m = twinModel(c, inc);
    engine.current.setModel(m);
    const sig = `${m.suspect?.id ?? ''}|${m.atRisk.join()}|${m.wards.map((w) => w.state).join()}|${m.beacons.map((b) => b.id + b.score + b.held).join()}`;
    if (sig !== lastSig.current) { lastSig.current = sig; onModel?.(m); }
  }, [c, inc]);

  const focusKey = (focus ?? []).join();
  useEffect(() => { engine.current?.setFocus(focus ?? []); }, [focusKey]);

  return (
    <div className={`twin ${mode} ${failed ? 'no-webgl' : ''}`} aria-hidden={mode === 'ambient'}>
      <div ref={host} className="twin-gl" />
      <div ref={overlay} className="twin-labels" />
    </div>
  );
}
