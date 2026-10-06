import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMExpressionPresetName } from "@pixiv/three-vrm";

// Resolve assets relative to this script, not the page. That way the viewer
// works from any URL path (e.g. /peaches.html or /joi/).
const BASE = new URL(".", import.meta.url);
const MODEL_URL = new URL("models/Seed-san.vrm", BASE).href;
const TTS_URL = "http://127.0.0.1:8880/tts";

// ?probe=1 enables framebuffer readback so a rendered character can be verified
// numerically (no human or model eyes required).
const PROBE = new URLSearchParams(location.search).has("probe");

const boot = document.getElementById("boot");
const bootMsg = document.getElementById("bootMsg");
const bootBar = document.getElementById("bootBar");
const hud = document.getElementById("hud");

function status(msg, pct) {
  bootMsg.textContent = msg;
  if (pct != null) bootBar.style.width = pct + "%";
}
function fail(msg) {
  bootMsg.textContent = msg;
  bootMsg.classList.add("error");
}

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  preserveDrawingBuffer: PROBE,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161c);

const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.35, 0.9);
camera.lookAt(0, 1.25, 0);

const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(1.6, 2.6, 2.2);
scene.add(key);
scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
const rim = new THREE.DirectionalLight(0x88aaff, 1.1);
rim.position.set(-2, 1.4, -1.8);
scene.add(rim);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- load VRM
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

let vrm = null;

loader.load(
  MODEL_URL,
  (gltf) => {
    // In three-vrm 3.x the VRM is attached to gltf.userData by VRMLoaderPlugin.
    vrm = gltf.userData.vrm;
    if (!vrm) {
      console.error("[joi] gltf loaded but no VRM in userData - wrong plugin or VRM version");
      fail("This file is not a VRM 1.0 avatar.");
      return;
    }
    vrm.scene.rotation.y = 0.15;
    scene.add(vrm.scene);

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    console.log("[joi] avatar height (m):", size.y.toFixed(3), "center:", center.toArray());

    // Frame the head. The bounding-box centre is at half height, so adding a
    // fraction of height to it aims the camera above the head, into empty space.
    // Anchor to the top of the box instead.
    const h = size.y;
    const top = box.max.y;
    const headY = top - h * 0.13;
    const focus = new THREE.Vector3(center.x, headY, center.z);
    camera.position.set(focus.x, headY + h * 0.04, focus.z + h * 0.36);
    camera.lookAt(focus);
    console.log("[joi] frame: head y", headY.toFixed(2), "top", top.toFixed(2));

    wireUi(vrm);
    boot.classList.add("gone");
    hud.hidden = false;
    renderer.setAnimationLoop(frame);
    window.__joiReady = true;
  },
  (ev) => {
    if (ev.total) status("Loading avatar…", Math.round((ev.loaded / ev.total) * 100));
  },
  (err) => {
    console.error("[joi] model load failed", err);
    fail("Could not load the avatar: " + err.message);
  }
);

// ---------------------------------------------------------------- expressions
let current = "neutral";
const activeButtons = new Map();

function setExpression(name, weight = 1) {
  if (!vrm) return;
  const n = name === "_rest" ? VRMExpressionPresetName.neutral : name;
  current = n;
  vrm.expressionManager.setValue(n, weight);
  for (const [btnName, el] of activeButtons) el.classList.toggle("on", btnName === name);
}

function wireUi(v) {
  const em = v.expressionManager;

  // Report which presets the model actually exposes, so a missing one is a
  // visible console fact rather than a silent no-op.
  const available = new Set(em.expressions.map((e) => e.expressionName));
  const wanted = ["neutral", "happy", "angry", "sad", "relaxed", "surprised", "fun", "blink"];
  const missing = wanted.filter((w) => !available.has(w));
  console.log("[joi] expressions:", [...available].join(", "));
  if (missing.length) console.warn("[joi] model lacks presets:", missing.join(", "));

  document.querySelectorAll("[data-expr]").forEach((b) => {
    const name = b.dataset.expr;
    if (!available.has(name)) {
      b.disabled = true;
      b.title = "not present in this avatar";
    } else {
      b.addEventListener("click", () => setExpression(name));
      activeButtons.set(name, b);
    }
  });

  document.querySelectorAll("[data-viseme]").forEach((b) => {
    b.addEventListener("click", () => {
      const v2 = b.dataset.viseme;
      const val = v2 === "_rest" ? 0 : 1;
      if (v2 !== "_rest") setExpression("neutral");
      em.setValue(VRMExpressionPresetName.neutral, v2 === "_rest" ? 1 : 0);
      if (v2 !== "_rest") em.setValue(v2, val);
      for (const el of document.querySelectorAll("[data-viseme]")) el.classList.remove("on");
      b.classList.add("on");
    });
  });

  const input = document.getElementById("speak");
  const go = () => { const t = input.value.trim(); if (t) speak(t); };
  document.getElementById("talk").addEventListener("click", go);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

// ---------------------------------------------------------------- TTS + visemes
let audioCtx = null;
let activeAudio = null;

const VISEMES = ["aa", "ih", "ou", "ee", "oh"];

async function speak(text) {
  if (!vrm) return;
  console.log("[joi] requesting TTS:", text);

  let res;
  try {
    res = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.warn("[joi] TTS service unreachable at", TTS_URL, "- falling back to demo visemes");
    return demoLipsync(2.2);
  }
  if (!res.ok) {
    console.warn("[joi] TTS returned", res.status, "- falling back to demo visemes");
    return demoLipsync(2.2);
  }

  const blob = await res.blob();
  playWithVisemes(blob);
}

/** Rough amplitude-driven visemes from the live audio signal. */
function playWithVisemes(blob) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (activeAudio) { activeAudio.src.stop(); }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  audio.play().catch((e) => console.warn("[joi] autoplay blocked:", e.message));

  const src = audioCtx.createMediaElementSource(audio);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  analyser.connect(audioCtx.destination);

  const buf = new Uint8Array(analyser.frequencyBinCount);
  let phase = 0;

  function drive() {
    if (activeAudio !== audio) return;
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let i = 0; i < 24; i++) sum += buf[i];
    const amp = Math.min(1, sum / (24 * 140));

    if (amp > 0.06) {
      phase += 0.32;
      const v = VISEMES[Math.floor(phase) % VISEMES.length];
      for (const name of VISEMES) vrm.expressionManager.setValue(name, name === v ? amp : 0);
    } else {
      for (const name of VISEMES) vrm.expressionManager.setValue(name, 0);
    }
    requestAnimationFrame(drive);
  }
  drive();

  audio.onended = () => {
    URL.revokeObjectURL(url);
    for (const name of VISEMES) vrm.expressionManager.setValue(name, 0);
  };
}

/** Lip movement without any TTS, so the feature is demonstrable offline. */
function demoLipsync(seconds) {
  if (!vrm) return;
  const t0 = performance.now();
  let phase = 0;
  (function step() {
    const el = (performance.now() - t0) / 1000;
    if (el > seconds) {
      for (const n of VISEMES) vrm.expressionManager.setValue(n, 0);
      return;
    }
    phase += 0.3;
    const v = VISEMES[Math.floor(phase) % VISEMES.length];
    const amp = 0.5 + 0.5 * Math.sin(el * 11);
    for (const n of VISEMES) vrm.expressionManager.setValue(n, n === v ? amp : 0);
    requestAnimationFrame(step);
  })();
}

// ---------------------------------------------------------------- render probe
// Counts how much of the frame is non-background and how many distinct colours
// appear. A blank canvas fails this; a rendered character does not.
function probe() {
  const w = canvas.width;
  const h = canvas.height;
  const gl = renderer.getContext();
  // Force rasterisation to complete before reading back, otherwise the buffer
  // can legitimately still be empty.
  gl.finish();
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

  const bg = [0x14, 0x16, 0x1c];
  let nonBg = 0;
  const seen = new Set();
  for (let i = 0; i < px.length; i += 4) {
    const d =
      Math.abs(px[i] - bg[0]) + Math.abs(px[i + 1] - bg[1]) + Math.abs(px[i + 2] - bg[2]);
    if (d > 18) nonBg++;
    seen.add((px[i] >> 3) * 1024 + (px[i + 1] >> 3) * 32 + (px[i + 2] >> 3));
  }

  const coverage = nonBg / (w * h);
  const result = {
    canvas: [w, h],
    coverage: Number(coverage.toFixed(4)),
    distinctColors: seen.size,
    glRenderer: (() => {
      const d = gl.getExtension("WEBGL_debug_renderer_info");
      return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : "n/a";
    })(),
    expressionNames: vrm ? vrm.expressionManager.expressions.length : 0,
    triangles: renderer.info.render.triangles,
    calls: renderer.info.render.calls,
    camera: camera.position.toArray().map((n) => Number(n.toFixed(2))),
    inScene: vrm ? !!vrm.scene.parent : false,
  };
  // Kept short and single-line on purpose: Chrome's log emitter hard-wraps
  // long lines, which breaks downstream parsing.
  console.log(
    `[joi] PROBEOK frame=${probeFrame} cover=${result.coverage} colors=${result.distinctColors} tris=${result.triangles} calls=${result.calls} expr=${result.expressionNames} inScene=${result.inScene} cam=${result.camera.join("/")} w=${w} h=${h}`
  );
  window.__joiProbe = result;
}

// ---------------------------------------------------------------- render loop
const clock = new THREE.Timer();

function frame() {
  clock.update();
  const dt = Math.min(clock.getDelta(), 0.1);

  if (vrm) {
    // idle blink, roughly every 4s
    const t = clock.getElapsed();
    const b = Math.max(0, Math.sin((t % 4) * Math.PI * 2 / 3.4) - 0.985) * 60;
    vrm.expressionManager.setValue(VRMExpressionPresetName.blink, Math.min(1, b));

    // subtle breathing + sway so it never looks frozen
    const s = vrm.scene;
    s.position.y = Math.sin(t * 1.1) * 0.006;
    s.rotation.y = 0.15 + Math.sin(t * 0.45) * 0.05;

    vrm.update(dt);
  }

  renderer.render(scene, camera);

  // Probe on a later frame: reading immediately after the load callback can
  // catch a frame that was never rasterised, which reads as coverage 0.
  if (PROBE && ++probeFrame === PROBE_AT) probe();
}
let probeFrame = 0;
const PROBE_AT = Number(new URLSearchParams(location.search).get("probeAt") ?? 120);

addEventListener("pointermove", (e) => {
  if (!vrm) return;
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = (e.clientY / innerHeight) * 2 - 1;
  vrm.lookAt.lookAt(nx * 4, 1.3 + ny * -2, 0);
});