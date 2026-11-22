import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * A live 3D picture of what BharatPulse does: a city as a graph. Blue nodes are wards and pipes, links are the network,
 * saffron pulses are reports flowing in, red nodes are open problems, the orange one is the likely failure point,
 * grey nodes on the edge are a fake-report ring held apart.
 * Variants: 'city' (dark, landing and officer sign-in), 'sky' (light, citizen screens).
 * Respects prefers-reduced-motion (one still frame), pauses when hidden, and uses fewer nodes on small devices.
 */
export default function Scene3D({ variant = 'city', offset = 0 }: { variant?: 'city' | 'sky'; offset?: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    if (typeof WebGLRenderingContext === 'undefined') { el.classList.add('no-webgl'); return; } // no WebGL at all: the CSS gradient stays
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      el.classList.add('no-webgl');
      return;
    }
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const small = Math.min(window.innerWidth, window.innerHeight) < 600 || (navigator.hardwareConcurrency ?? 8) <= 4;
    const dark = variant === 'city';
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    camera.position.set(0, 9, 26);
    camera.lookAt(0, 0, 0);
    const world = new THREE.Group();
    scene.add(world);
    const holder = world; // moved sideways on wide screens so text stays readable

    // --- a city-shaped graph: nodes spread on a disc with some height, linked to their nearest neighbours ---
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const N = small ? 46 : 78;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < N; i++) {
      const r = 2 + Math.sqrt(rnd()) * 11;
      const a = rnd() * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, (rnd() - 0.5) * 3.2, Math.sin(a) * r * 0.75));
    }
    pts[0].set(0, 0.5, 0); // the tank
    const edges: [number, number][] = [];
    const key = new Set<string>();
    pts.forEach((p, i) => {
      const near = pts.map((q, j) => ({ j, d: p.distanceTo(q) })).filter((x) => x.j !== i).sort((a, b) => a.d - b.d).slice(0, 2);
      for (const { j } of near) { const k = i < j ? `${i}-${j}` : `${j}-${i}`; if (!key.has(k)) { key.add(k); edges.push([i, j]); } }
    });
    for (let i = 1; i < 6; i++) edges.push([0, i * 3]); // trunk mains from the tank

    const lineGeo = new THREE.BufferGeometry().setFromPoints(edges.flatMap(([a, b]) => [pts[a], pts[b]]));
    world.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: dark ? 0x7bebc2 : 0x3fc594, transparent: true, opacity: dark ? 0.35 : 0.4 })));

    const incidents = new Set([9, 17, 26, 41]);
    const ring = new Set([N - 1, N - 2, N - 3, N - 4]);
    const suspect = 12;
    const sphere = new THREE.SphereGeometry(1, 18, 14);
    const nodes = new THREE.InstancedMesh(sphere, new THREE.MeshBasicMaterial(), N);
    const color = new THREE.Color();
    const m = new THREE.Matrix4();
    const baseSize = (i: number) => (i === 0 ? 0.42 : i === suspect ? 0.4 : incidents.has(i) ? 0.27 : 0.14 + rnd() * 0.09);
    const sizes = pts.map((_, i) => baseSize(i));
    pts.forEach((p, i) => {
      color.set(i === suspect ? 0xf97316 : incidents.has(i) ? 0xe5484d : ring.has(i) ? 0x8aa99e : i === 0 ? 0x22c55e : dark ? 0x95ebcb : 0x24b47f);
      nodes.setColorAt(i, color);
      m.makeScale(sizes[i], sizes[i], sizes[i]).setPosition(p);
      nodes.setMatrixAt(i, m);
    });
    world.add(nodes);

    // glow halo on the suspect asset and on incidents
    const haloTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d')!; const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();
    const halo = (hex: number, size: number) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: hex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); s.scale.setScalar(size); return s; };
    const halos: { s: THREE.Sprite; base: number; phase: number }[] = [];
    for (const i of [suspect, ...incidents]) { const s = halo(i === suspect ? 0xf97316 : 0xe5484d, i === suspect ? 2.6 : 1.6); s.position.copy(pts[i]); world.add(s); halos.push({ s, base: s.scale.x, phase: rnd() * 6 }); }

    // the fake ring: dashed loop around the grey nodes
    const ringPts = [...ring].map((i) => pts[i]);
    const ringLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ringPts), new THREE.LineDashedMaterial({ color: 0x8aa99e, dashSize: 0.3, gapSize: 0.25, transparent: true, opacity: 0.8 }));
    ringLine.computeLineDistances();
    world.add(ringLine);

    // pulses: reports travelling along the network
    const P = small ? 18 : 34;
    const pulses = Array.from({ length: P }, () => {
      const s = halo(0xffa94d, 0.6);
      world.add(s);
      return { s, e: Math.floor(rnd() * edges.length), t: rnd(), v: 0.004 + rnd() * 0.008 };
    });

    // a faint city grid underneath
    const grid = new THREE.GridHelper(40, 40, dark ? 0x369b76 : 0x95ebcb, dark ? 0x237054 : 0xb9e3d4);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = dark ? 0.35 : 0.5;
    grid.position.y = -2.4;
    world.add(grid);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.position.z = w < 700 ? 34 : 26;
      holder.position.x = w > 900 ? offset : 0;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let mx = 0;
    let my = 0;
    const move = (e: PointerEvent) => { mx = (e.clientX / window.innerWidth - 0.5) * 2; my = (e.clientY / window.innerHeight - 0.5) * 2; };
    window.addEventListener('pointermove', move, { passive: true });

    let visible = true;
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
    io.observe(el);
    let raf = 0;
    let t = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      t += 1;
      world.rotation.y += 0.0016;
      world.rotation.x += ((my * 0.12 + 0.05) - world.rotation.x) * 0.03;
      camera.position.x += (mx * 2.2 - camera.position.x) * 0.03;
      camera.lookAt(0, 0, 0);
      for (const p of pulses) {
        p.t += p.v;
        if (p.t >= 1) { p.t = 0; p.e = Math.floor(rnd() * edges.length); }
        const [a, b] = edges[p.e];
        p.s.position.lerpVectors(pts[a], pts[b], p.t);
      }
      for (const h of halos) h.s.scale.setScalar(h.base * (1 + 0.18 * Math.sin(t * 0.05 + h.phase)));
      renderer.render(scene, camera);
    };
    if (still) renderer.render(scene, camera);
    else frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', move);
      scene.traverse((o) => { const x = o as THREE.Mesh; x.geometry?.dispose?.(); const mat = x.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((mm) => mm.dispose()); });
      haloTex.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [variant, offset]);
  return <div ref={host} className={`scene3d ${variant}`} aria-hidden="true" />;
}
