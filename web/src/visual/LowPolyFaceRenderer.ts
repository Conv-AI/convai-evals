import * as THREE from "three";
import type { LipSyncValues, VisualSnapshot, VisualTimelineSample } from "./visualTypes.js";

const ZERO_LIPS: LipSyncValues = {
  jawOpen: 0,
  mouthClose: 0,
  mouthFunnel: 0,
  mouthPucker: 0,
  mouthSmileLeft: 0,
  mouthSmileRight: 0,
  mouthStretchLeft: 0,
  mouthStretchRight: 0,
  mouthRollLower: 0,
  mouthRollUpper: 0,
  tongueOut: 0,
};

export class LowPolyFaceRenderer {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private renderer: THREE.WebGLRenderer;
  private frameHandle = 0;
  private mountEl: HTMLElement | null = null;
  private head = new THREE.Group();
  private lowerLip: THREE.Mesh;
  private upperLip: THREE.Mesh;
  private lowerTeeth: THREE.Mesh;
  private upperTeeth: THREE.Mesh;
  private mouthInterior: THREE.Mesh;
  private jaw: THREE.Mesh;
  private leftMouthCorner: THREE.Mesh;
  private rightMouthCorner: THREE.Mesh;
  private lips: LipSyncValues = { ...ZERO_LIPS };
  private mouthSignal = 0;
  private pixelSignal = 0;
  private lastRenderMs = performance.now();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x101923);
    this.camera.position.set(0, 0.18, 5.8);

    const ambient = new THREE.AmbientLight(0xffffff, 1.8);
    const key = new THREE.DirectionalLight(0xfff4dd, 2.2);
    key.position.set(3, 4, 5);
    const fill = new THREE.DirectionalLight(0x7dd3fc, 0.8);
    fill.position.set(-4, 1, 3);
    this.scene.add(ambient, key, fill);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.2, 1.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x31506b, roughness: 0.75, metalness: 0.05 }),
    );
    body.position.y = -1.55;
    this.scene.add(body);

    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.42, 0.7, 6),
      new THREE.MeshStandardMaterial({ color: 0xd7a279, roughness: 0.7 }),
    );
    neck.position.y = -0.8;
    this.scene.add(neck);

    const headMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.28, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xe4b087, roughness: 0.85 }),
    );
    headMesh.scale.set(0.94, 1.08, 0.72);
    this.head.add(headMesh);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.42, 5),
      new THREE.MeshStandardMaterial({ color: 0xc98766, roughness: 0.8 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.05, 0.98);
    this.head.add(nose);

    for (const x of [-0.42, 0.42]) {
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.105, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x050608, roughness: 0.4 }),
      );
      eye.position.set(x, 0.36, 0.96);
      this.head.add(eye);
    }

    this.mouthInterior = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.22, 0.04),
      new THREE.MeshBasicMaterial({ color: 0x050505 }),
    );
    this.mouthInterior.position.set(0, -0.34, 1.05);
    this.head.add(this.mouthInterior);

    const lipMaterial = new THREE.MeshStandardMaterial({ color: 0xcf284d, roughness: 0.5 });
    this.upperLip = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.07, 0.075), lipMaterial);
    this.lowerLip = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.08, 0.075), lipMaterial);
    this.upperLip.position.set(0, -0.22, 1.085);
    this.lowerLip.position.set(0, -0.47, 1.085);

    const toothMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.upperTeeth = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.05, 0.03), toothMaterial);
    this.lowerTeeth = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.045, 0.03), toothMaterial);
    this.upperTeeth.position.set(0, -0.285, 1.112);
    this.lowerTeeth.position.set(0, -0.405, 1.112);

    const cornerMaterial = new THREE.MeshBasicMaterial({ color: 0x22d3ee });
    this.leftMouthCorner = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.04), cornerMaterial);
    this.rightMouthCorner = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.16, 0.04), cornerMaterial);
    this.leftMouthCorner.position.set(-0.53, -0.35, 1.13);
    this.rightMouthCorner.position.set(0.53, -0.35, 1.13);
    this.head.add(
      this.upperLip,
      this.lowerLip,
      this.upperTeeth,
      this.lowerTeeth,
      this.leftMouthCorner,
      this.rightMouthCorner,
    );

    this.jaw = new THREE.Mesh(
      new THREE.BoxGeometry(0.82, 0.26, 0.11),
      new THREE.MeshStandardMaterial({ color: 0xd59b77, roughness: 0.75 }),
    );
    this.jaw.position.set(0, -0.71, 0.84);
    this.head.add(this.jaw);

    this.scene.add(this.head);
  }

  mount(el: HTMLElement): void {
    this.mountEl = el;
    el.innerHTML = "";
    el.appendChild(this.renderer.domElement);
    this.resize();
    window.addEventListener("resize", this.resize);
    this.animate();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) this.renderer.domElement.remove();
  }

  setLipValues(values: Partial<LipSyncValues>): void {
    this.lips = { ...ZERO_LIPS, ...values };
  }

  resetMouth(): void {
    this.setLipValues(ZERO_LIPS);
    this.mouthSignal = 0;
    this.pixelSignal = 0;
    this.updateFace(1, 0);
  }

  getMouthSignal(): number {
    return this.mouthSignal;
  }

  getPixelSignal(): number {
    return this.pixelSignal;
  }

  makeSample(tMs: number, audioLevel: number): VisualTimelineSample {
    return {
      tMs,
      audioLevel,
      visualMouth: this.mouthSignal,
      pixelMouth: this.pixelSignal,
      jawOpen: this.lips.jawOpen,
      mouthFunnel: this.lips.mouthFunnel,
      mouthPucker: this.lips.mouthPucker,
      mouthSmile: Math.max(this.lips.mouthSmileLeft, this.lips.mouthSmileRight),
      mouthStretch: Math.max(this.lips.mouthStretchLeft, this.lips.mouthStretchRight),
      mouthClose: this.lips.mouthClose,
    };
  }

  captureSnapshot(label: string, tMs: number, audioLevel: number): VisualSnapshot {
    return {
      label,
      tMs,
      dataUrl: this.renderer.domElement.toDataURL("image/jpeg", 0.72),
      audioLevel,
      visualMouth: this.mouthSignal,
    };
  }

  private resize = (): void => {
    if (!this.mountEl) return;
    const rect = this.mountEl.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(280, Math.floor(rect.height || width * 0.72));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private animate = (): void => {
    const now = performance.now();
    const elapsed = now * 0.001;
    const dt = Math.min(0.08, (now - this.lastRenderMs) / 1000);
    this.lastRenderMs = now;
    this.updateFace(dt, elapsed);
    this.renderer.render(this.scene, this.camera);
    this.pixelSignal = this.measureMouthPixels();
    this.frameHandle = requestAnimationFrame(this.animate);
  };

  private updateFace(dt: number, _elapsed: number): void {
    const rounded = Math.max(this.lips.mouthFunnel, this.lips.mouthPucker);
    const wide = Math.max(
      this.lips.mouthSmileLeft,
      this.lips.mouthSmileRight,
      this.lips.mouthStretchLeft,
      this.lips.mouthStretchRight,
    );
    const open = clamp01(this.lips.jawOpen * 0.82 + rounded * 0.24 + wide * 0.18 - this.lips.mouthClose * 0.3);
    const target = open;
    this.mouthSignal += (target - this.mouthSignal) * Math.min(1, dt * 18);

    const width = 0.9 + wide * 0.66 - rounded * 0.22;
    const height = 0.06 + this.mouthSignal * 0.72 + rounded * 0.1;
    this.mouthInterior.scale.set(Math.max(0.42, width / 0.92), Math.max(0.12, height / 0.22), 1);
    this.upperLip.position.y = -0.245 + rounded * 0.028;
    this.lowerLip.position.y = -0.41 - this.mouthSignal * 0.4;
    this.lowerLip.scale.x = 1 + wide * 0.36 - rounded * 0.08;
    this.upperLip.scale.x = 1 + wide * 0.28 - rounded * 0.08;
    this.upperTeeth.position.y = this.upperLip.position.y - 0.07;
    this.lowerTeeth.position.y = this.lowerLip.position.y + 0.07;
    this.lowerTeeth.visible = this.mouthSignal > 0.08;
    this.leftMouthCorner.position.x = -width * 0.58;
    this.rightMouthCorner.position.x = width * 0.58;
    this.jaw.position.y = -0.71 - this.mouthSignal * 0.2;
    this.jaw.rotation.x = -this.mouthSignal * 0.18;
    this.head.rotation.y = 0;
    this.head.rotation.x = 0;
  }

  private measureMouthPixels(): number {
    const canvas = this.renderer.domElement;
    const gl = this.renderer.getContext();
    const width = canvas.width;
    const height = canvas.height;
    if (width <= 0 || height <= 0) return this.mouthSignal;

    const roiW = Math.max(20, Math.floor(width * 0.26));
    const roiH = Math.max(16, Math.floor(height * 0.18));
    const x = Math.floor(width * 0.5 - roiW / 2);
    const y = Math.floor(height * 0.385 - roiH / 2);
    const pixels = new Uint8Array(roiW * roiH * 4);
    gl.readPixels(x, y, roiW, roiH, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i] ?? 0;
      const g = pixels[i + 1] ?? 0;
      const b = pixels[i + 2] ?? 0;
      if (r + g + b < 120) dark += 1;
    }
    return clamp01((dark / (roiW * roiH) - 0.04) / 0.18);
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
