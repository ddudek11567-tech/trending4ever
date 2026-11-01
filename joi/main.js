// Peaches viewer — VRM 1.0 expressions, visemes, and TTS-driven lip-sync.
//
// Copyright (c) 2026 ddudek11567-tech. All rights reserved. See LICENSE.md.
// Avatar "Seed-san" (c) VirtualCast, Inc. — VRM 1.0, used with credit.
// Depends on three.js (MIT) and @pixiv/three-vrm (MIT).

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMExpressionPresetName } from "@pixiv/three-vrm";

// Resolve assets relative to this script, not the page. That way the viewer
// works from any URL path (e.g. /peaches.html or /joi/).
const BASE = new URL(".", import.meta.url);
const MODEL_URL = new URL("models/Seed-san.vrm", BASE).href;
// Prefer the same-origin /tts endpoint, which carries the auth cookie and works
// whether the page is served by serve.py locally or in the cloud. Fall back to a
// standalone Kokoro server when this page is opened as a standalone file.
const SAME_ORIGIN_TTS = "/tts";
const LOCAL_TTS = "http://127.0.0.1:8880/api/tts";
let ttsUrl = location.protocol === "file:" ? LOCAL_TTS : SAME_ORIGIN_TTS;

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

// Filled in once the avatar loads; reframe() needs it on every resize.
let frameTarget = null;

// Fit the whole figure in view for the current aspect ratio. Called on load and
// on resize, so a narrow window crops nothing.
function reframe() {
  if (!frameTarget) return;
  const { focus, height, width } = frameTarget;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const tan = 2 * Math.tan(vFov / 2);
  const dist = Math.max(height / tan, width / (tan * camera.aspect)) * 1.18;
  camera.position.set(focus.x, focus.y + height * 0.02, focus.z + dist);
  camera.lookAt(focus);
}

// Box3.setFromObject includes invisible meshes, so build the box from visible
// geometry only - otherwise a hidden part still inflates the framing.
function visibleBox(root) {
  const out = new THREE.Box3();
  const one = new THREE.Box3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    for (let p = o; p; p = p.parent) if (!p.visible) return;
    one.setFromObject(o);
    if (!one.isEmpty()) out.union(one);
  });
  return out;
}

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
  reframe();
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
      console.error("[peaches] gltf loaded but no VRM in userData - wrong plugin or VRM version");
      fail("This file is not a VRM 1.0 avatar.");
      return;
    }
    vrm.scene.rotation.y = 0.15;
    scene.add(vrm.scene);

    // This model ships a huge mechanical arm (robo_arm_1/2/3, 1.65 m long) that
    // hangs off her shoulder at neck height. It dominated the frame and read as
    // a white robot arm, so hide it. This is a runtime change: the .vrm file is
    // untouched and the meshes stay in the graph, so it can be toggled back.
    const hiddenParts = [];
    vrm.scene.traverse((o) => {
      if (o.isMesh && /^robo_arm/i.test(o.name)) {
        o.visible = false;
        hiddenParts.push(o.name);
      }
    });
    console.log("[peaches] hidden meshes:", hiddenParts.join(", ") || "(none)");

    const box = visibleBox(vrm.scene);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    console.log(
      "[peaches] box min", box.min.toArray().map((n) => +n.toFixed(2)).join("/"),
      "max", box.max.toArray().map((n) => +n.toFixed(2)).join("/"),
      "size", size.toArray().map((n) => +n.toFixed(2)).join("/")
    );

    // Do NOT frame on the bounding-box centre. This model's box is 2.24 m wide
    // (the robo_arm meshes) and lopsided, x -0.79..1.45, so its centre sits
    // 0.33 m off the body axis. Framing there put the head off the right edge,
    // and a 0.36*h camera distance left it 0.57 m from a 1.58 m figure - i.e.
    // inside the chest, which rendered as a white blob.
    //
    // Take the body axis from the humanoid head bone, use the box only for
    // height, and solve the distance that actually fits the figure in frame.
    const h = size.y;
    vrm.scene.updateMatrixWorld(true);
    const headBone = vrm.humanoid?.getNormalizedBoneNode("head");
    const headPos = new THREE.Vector3();
    if (headBone) headBone.getWorldPosition(headPos);
    else headPos.set(center.x, box.max.y - h * 0.13, center.z);

    frameTarget = {
      focus: new THREE.Vector3(headPos.x, box.min.y + h * 0.5, headPos.z),
      height: h,
      width: size.x,
    };
    reframe();
    console.log(
      "[peaches] frame: axis", headPos.x.toFixed(2), headPos.z.toFixed(2),
      "h", h.toFixed(2), "dist", camera.position.distanceTo(frameTarget.focus).toFixed(2)
    );
    if (PROBE) {
      const m = vrm.meta || {};
      console.log(
        "[peaches] meta",
        JSON.stringify({
          name: m.name,
          authors: m.authors,
          modification: m.modification,
          commercialUsage: m.commercialUsage,
          creditNotation: m.creditNotation,
          allowRedistribution: m.allowRedistribution,
          licenseUrl: m.licenseUrl,
        })
      );
      vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        const b = new THREE.Box3().setFromObject(o);
        if (b.isEmpty()) return;
        const s = b.getSize(new THREE.Vector3());
        console.log(
          "[peaches] mesh", o.name || "(unnamed)",
          "min", b.min.toArray().map((n) => +n.toFixed(2)).join("/"),
          "size", s.toArray().map((n) => +n.toFixed(2)).join("/")
        );
      });
    }

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
    console.error("[peaches] model load failed", err);
    fail("Could not load the avatar: " + err.message);
  }
);

// ---------------------------------------------------------------- expressions
const activeButtons = new Map();

function setExpression(name, weight = 1) {
  if (!vrm) return;
  const n = name === "_rest" ? VRMExpressionPresetName.neutral : name;
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
  console.log("[peaches] expressions:", [...available].join(", "));
  if (missing.length) console.warn("[peaches] model lacks presets:", missing.join(", "));

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
      const name = b.dataset.viseme;
      const val = name === "_rest" ? 0 : 1;
      if (name !== "_rest") em.setValue(VRMExpressionPresetName.neutral, 0);
      else em.setValue(VRMExpressionPresetName.neutral, 1);
      if (name !== "_rest") em.setValue(name, val);
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

async function requestTTS(url, text) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Same-origin requests must carry the session cookie.
    credentials: "same-origin",
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.blob();
}

async function speak(text) {
  if (!vrm) return;
  console.log("[peaches] requesting TTS:", text);

  let blob = null;
  try {
    blob = await requestTTS(ttsUrl, text);
  } catch (e) {
    console.warn(`[peaches] TTS failed at ${ttsUrl}: ${e.message}`);
    // If same-origin is unavailable, try a standalone local Kokoro server once.
    if (ttsUrl !== LOCAL_TTS) {
      try {
        blob = await requestTTS(LOCAL_TTS, text);
        ttsUrl = LOCAL_TTS;
        console.log("[peaches] using local Kokoro fallback");
      } catch (e2) {
        console.warn(`[peaches] local fallback also failed: ${e2.message}`);
      }
    }
  }

  if (!blob) {
    console.warn("[peaches] no audio; showing demo lip-sync instead");
    return demoLipsync(2.2);
  }
  playWithVisemes(blob);
}

/** Rough amplitude-driven visemes from the live audio signal. */
function playWithVisemes(blob) {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  // Stop any in-flight clip before starting a new one. Audio elements have
  // .pause(); there is no .src.stop().
  if (activeAudio) {
    activeAudio.onended = null;
    activeAudio.pause();
    for (const n of VISEMES) vrm.expressionManager.setValue(n, 0);
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  audio.play().catch((e) => console.warn("[peaches] autoplay blocked:", e.message));

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
    `[peaches] PROBEOK frame=${probeFrame} cover=${result.coverage} colors=${result.distinctColors} tris=${result.triangles} calls=${result.calls} expr=${result.expressionNames} inScene=${result.inScene} cam=${result.camera.join("/")} w=${w} h=${h}`
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