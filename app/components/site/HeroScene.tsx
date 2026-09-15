"use client";

import { useEffect, useRef } from "react";
import { useReducedMotion, type MotionValue } from "framer-motion";
import { cn } from "@/lib/cn";

type Three = typeof import("three");
type RoomEnvironmentModule = typeof import("three/examples/jsm/environments/RoomEnvironment.js");

export type HeroSceneProps = {
  /** Hero section progress (see `useSectionProgress`); pinned from 0.2 to 0.8. */
  progress: MotionValue<number>;
  /** Called once the first frame is on screen. */
  onReady?: () => void;
  className?: string;
};

/**
 * The hero's 3D field, drawn with three.js: brushed-metal triangle frames
 * scattered around a frosted crystal with a blue core. As the hero scrolls
 * the frames gather into a shell around the crystal (0.2 to 0.5), then the
 * whole cluster shrinks behind the payoff line (0.5 to 0.72). The wrapper in
 * `Hero` fades the canvas out after that.
 *
 * three.js is imported inside the effect, so it is a separate chunk that
 * never blocks the page's first paint, and the scene renders only while the
 * hero is on screen and the tab is visible. With `prefers-reduced-motion`
 * the scene still follows the scroll (the reader drives it) but nothing
 * animates on its own: no fly-in, no drift, no pointer parallax. If WebGL is
 * unavailable nothing is drawn and the headline stands alone.
 */
export function HeroScene({ progress, onReady, className }: HeroSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  const reduceMotion = useReducedMotion() ?? false;

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let teardown = () => {};

    void Promise.all([import("three"), import("three/examples/jsm/environments/RoomEnvironment.js")]).then(
      ([THREE, room]) => {
        if (disposed) return;
        teardown = mountScene({
          THREE,
          room,
          host,
          progress,
          reduceMotion,
          onReady: () => onReadyRef.current?.(),
        });
      },
    );

    return () => {
      disposed = true;
      teardown();
    };
  }, [progress, reduceMotion]);

  return <div ref={hostRef} aria-hidden="true" className={cn("absolute inset-0", className)} />;
}

// ── Scene ────────────────────────────────────────────────────────────────

const PAGE_COLOR = 0xfcfcfc;
const CORE_COLOR = 0x1c76ff;
/** Gunmetal to pale silver, the range of the reference's frames. */
const METALS = [0x2c2f37, 0x555a66, 0x8f97a6, 0xc5ccd8] as const;
const FRAME_COUNT = { wide: 21, narrow: 14 } as const;
/** Where the cluster gathers, and how far out its shell sits. */
const SHELL_RADIUS = 2.45;
const CRYSTAL_START_Y = -3.95;

type MountArgs = {
  THREE: Three;
  room: RoomEnvironmentModule;
  host: HTMLDivElement;
  progress: MotionValue<number>;
  reduceMotion: boolean;
  onReady: () => void;
};

/** Deterministic noise, so every visit sees the same composition. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function smoothstep(from: number, to: number, value: number) {
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}

function easeOutBack(t: number) {
  const overshoot = 1.4;
  const shifted = t - 1;
  return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
}

/** A slightly irregular triangle with a uniform-width band cut out of it. */
function frameGeometry(THREE: Three, random: () => number) {
  const rotation = random() * Math.PI * 2;
  const corners = [0, 1, 2].map((index) => {
    const angle = rotation + (index * Math.PI * 2) / 3 + (random() - 0.5) * 0.5;
    const radius = 0.78 + random() * 0.4;
    return new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius);
  });

  // Shrinking the corners toward the incenter by (r - band) / r offsets every
  // edge inward by exactly `band`, so the frame is even all the way round.
  const [a, b, c] = corners;
  const sideA = b.distanceTo(c);
  const sideB = a.distanceTo(c);
  const sideC = a.distanceTo(b);
  const perimeter = sideA + sideB + sideC;
  const incenter = new THREE.Vector2(
    (sideA * a.x + sideB * b.x + sideC * c.x) / perimeter,
    (sideA * a.y + sideB * b.y + sideC * c.y) / perimeter,
  );
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  const inradius = (2 * area) / perimeter;
  const band = Math.min(0.17, inradius * 0.45);
  const inner = corners.map((corner) => corner.clone().sub(incenter).multiplyScalar((inradius - band) / inradius).add(incenter));

  const shape = new THREE.Shape(corners);
  shape.holes.push(new THREE.Path(inner));

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.1,
    bevelEnabled: true,
    bevelThickness: 0.035,
    bevelSize: 0.03,
    bevelSegments: 2,
    curveSegments: 1,
  });
  geometry.center();
  return geometry;
}

function mountScene({ THREE, room, host, progress, reduceMotion, onReady }: MountArgs) {
  let renderer: InstanceType<Three["WebGLRenderer"]>;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  } catch {
    return () => {};
  }

  const narrow = window.matchMedia("(max-width: 767px)").matches;
  renderer.setClearColor(PAGE_COLOR, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, narrow ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = "block h-full w-full";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new room.RoomEnvironment(), 0.04).texture;
  scene.environment = environment;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 15);

  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(-4, 6, 8);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.35));

  const cluster = new THREE.Group();
  scene.add(cluster);

  // Crystal with its blue core. The core is opaque, so the crystal's
  // transmission pass sees it and blurs it through the frosted faces.
  const crystalMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.5,
    transmission: 1,
    thickness: 1.3,
    ior: 1.3,
    flatShading: true,
    clearcoat: 0.35,
    clearcoatRoughness: 0.3,
  });
  const crystalGeometry = new THREE.IcosahedronGeometry(1.4, 0);
  const crystal = new THREE.Mesh(crystalGeometry, crystalMaterial);
  const coreGeometry = new THREE.IcosahedronGeometry(0.4, 3);
  const coreMaterial = new THREE.MeshBasicMaterial({ color: CORE_COLOR });
  crystal.add(new THREE.Mesh(coreGeometry, coreMaterial));
  cluster.add(crystal);

  const random = seeded(20260915);
  const metalMaterials = METALS.map(
    (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.92, roughness: 0.3 }),
  );
  const count = narrow ? FRAME_COUNT.narrow : FRAME_COUNT.wide;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const forward = new THREE.Vector3(0, 0, 1);

  const frames = Array.from({ length: count }, (_, index) => {
    const geometry = frameGeometry(THREE, random);
    const mesh = new THREE.Mesh(geometry, metalMaterials[index % metalMaterials.length]);
    cluster.add(mesh);

    // Scattered: wide and low. Nothing rises into the nav band (y stays under
    // 2.5) and the headline's column stays clear (x within 4.4 of centre,
    // above y -0.3). On phones the headline spans the whole width, so every
    // frame starts below it.
    const scatter = new THREE.Vector3();
    do {
      scatter.set(-7.4 + random() * 14.8, -4.7 + 7.2 * random() ** 1.35, -3.2 + random() * 5);
    } while ((narrow || Math.abs(scatter.x) < 4.4) && scatter.y > -0.3);

    // Gathered: an even Fibonacci shell, each frame facing outward.
    const shellY = 1 - ((index + 0.5) * 2) / count;
    const ring = Math.sqrt(1 - shellY * shellY);
    const normal = new THREE.Vector3(Math.cos(index * goldenAngle) * ring, shellY, Math.sin(index * goldenAngle) * ring);
    const twist = new THREE.Quaternion().setFromAxisAngle(forward, random() * Math.PI * 2);

    return {
      mesh,
      geometry,
      scatter,
      scatterRotation: new THREE.Quaternion().setFromEuler(
        new THREE.Euler(random() * Math.PI * 2, random() * Math.PI * 2, random() * Math.PI * 2),
      ),
      scatterScale: 0.7 + random() * 0.65,
      gather: normal.clone().multiplyScalar(SHELL_RADIUS),
      gatherRotation: new THREE.Quaternion().setFromUnitVectors(forward, normal).multiply(twist),
      phase: random() * Math.PI * 2,
      spinDirection: index % 2 === 0 ? 1 : -1,
    };
  });

  // Viewport fit: on tall screens the scatter pulls in so it still frames the
  // headline rather than falling off both edges, and the whole cluster scales
  // down so the gathered shell fits the width.
  let spread = 1;
  let clusterFit = 1;
  const fit = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    spread = Math.min(1, Math.max(0.42, camera.aspect / 1.78));
    clusterFit = Math.min(1, 0.35 + spread * 0.65);
  };
  fit();
  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(host);

  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const onPointerMove = (event: PointerEvent) => {
    pointer.targetX = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.targetY = (event.clientY / window.innerHeight) * 2 - 1;
  };
  if (!reduceMotion && finePointer) window.addEventListener("pointermove", onPointerMove, { passive: true });

  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const crystalStart = new THREE.Vector3(0, CRYSTAL_START_Y, 0);
  const origin = new THREE.Vector3();
  const startedAt = performance.now();
  let announced = false;

  const renderFrame = (now: number) => {
    const seconds = (now - startedAt) / 1000;
    const scroll = progress.get();
    const gather = smoothstep(0.2, 0.5, scroll);
    const shrink = smoothstep(0.5, 0.72, scroll);
    const intro = reduceMotion ? 1 : clamp01(seconds / 1.6);

    pointer.x += (pointer.targetX - pointer.x) * 0.05;
    pointer.y += (pointer.targetY - pointer.y) * 0.05;

    frames.forEach((frame, index) => {
      const arrival = reduceMotion ? 1 : easeOutBack(clamp01((intro * 1.6 - index * 0.035) / 0.9));

      position.set(frame.scatter.x * spread, frame.scatter.y, frame.scatter.z).lerp(frame.gather, gather);
      if (!reduceMotion) position.y += Math.sin(seconds * 0.7 + frame.phase) * 0.09 * (1 - gather * 0.6);
      frame.mesh.position.copy(position);

      rotation.slerpQuaternions(frame.scatterRotation, frame.gatherRotation, gather);
      if (!reduceMotion) {
        spin.setFromAxisAngle(forward, seconds * 0.18 * frame.spinDirection * (1 - gather));
        rotation.multiply(spin);
      }
      frame.mesh.quaternion.copy(rotation);

      const size = frame.scatterScale + (0.6 - frame.scatterScale) * gather;
      frame.mesh.scale.setScalar(Math.max(0, size * arrival));
    });

    crystal.position.lerpVectors(crystalStart, origin, gather);
    if (!reduceMotion) crystal.position.y -= (1 - easeOutBack(clamp01(intro))) * 2;
    crystal.scale.setScalar(1.15 + (0.82 - 1.15) * gather);
    crystal.rotation.set(0.35 + gather * 0.6, (reduceMotion ? 0 : seconds * 0.2) + gather * 1.2, 0);

    cluster.rotation.set(pointer.y * 0.06, gather * 0.9 + (reduceMotion ? 0 : seconds * 0.08 * gather) + pointer.x * 0.1, 0);
    cluster.scale.setScalar((1 - 0.45 * shrink) * clusterFit);

    renderer.render(scene, camera);

    if (!announced) {
      announced = true;
      onReady();
    }
  };

  // Render only while the hero is on screen and the tab is visible.
  let onScreen = true;
  const sync = () => {
    renderer.setAnimationLoop(onScreen && document.visibilityState === "visible" ? renderFrame : null);
  };
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    sync();
  });
  visibilityObserver.observe(host);
  document.addEventListener("visibilitychange", sync);
  sync();

  return () => {
    renderer.setAnimationLoop(null);
    visibilityObserver.disconnect();
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("pointermove", onPointerMove);
    frames.forEach((frame) => frame.geometry.dispose());
    metalMaterials.forEach((material) => material.dispose());
    crystalGeometry.dispose();
    crystalMaterial.dispose();
    coreGeometry.dispose();
    coreMaterial.dispose();
    environment.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}
