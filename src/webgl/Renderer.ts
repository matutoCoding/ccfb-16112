import type { GuidePlan } from '../lib/guide';
import { createRig, type ProjectorRig } from '../lib/projectors';
import { mat4Multiply, mat4Perspective, mat4LookAt, v3, clamp } from '../lib/math';
import type { ProjectState } from '../types';
import { buildSceneGeometry, type SceneGeometry } from './sceneGeometry';
import {
  depthFragmentShader,
  depthVertexShader,
  lineFragmentShader,
  lineVertexShader,
  mainFragmentShader,
  mainVertexShader
} from './shaders';
import { createSlides, paintSlide, type ProjectorSlide } from './slides';
import { getStepWorkerRig } from '../lib/occlusion';

const MAX_PROJ = 4;
const SHADOW_SIZE = 1536;

export interface ViewStats {
  fps: number;
  triangles: number;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    console.error(source);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`WebGL 程序链接失败: ${gl.getProgramInfoLog(prog)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

interface CameraState {
  target: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  distance: number;
}

export class ProjectionViewer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private mainProgram: WebGLProgram;
  private depthProgram: WebGLProgram;
  private lineProgram: WebGLProgram;

  private vao: WebGLVertexArrayObject;
  private lineVao: WebGLVertexArrayObject;
  private geometryBuffers: WebGLBuffer[] = [];
  private indexCount = 0;
  private lineVertexCount = 0;
  private triangleCount = 0;

  private shadowFbos: WebGLFramebuffer[] = [];
  private shadowTextures: WebGLTexture[] = [];
  private shadowRenderbuffers: WebGLRenderbuffer[] = [];
  private slideTextures: Array<WebGLTexture | null> = [null, null, null, null];
  private dummyDepth: WebGLTexture;
  private dummySlide: WebGLTexture;

  private slides: ProjectorSlide[] = [];
  private slideSignature = '';
  private state: ProjectState | null = null;
  private plan: GuidePlan | null = null;
  private allWires = false;
  workerStepOrder?: number;
  private raf = 0;
  private disposed = false;
  private lastSlidePaint = 0;
  private lastStats = typeof performance === 'undefined' ? 0 : performance.now();
  private frames = 0;
  onStats?: (stats: ViewStats) => void;
  onContextLost?: () => void;

  private contextLost = false;

  private camera: CameraState = {
    target: { x: 1200, y: 600, z: 40 },
    yaw: -0.58,
    pitch: 0.64,
    distance: 3700
  };
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('当前浏览器或内嵌环境不支持 WebGL2');
    this.gl = gl;

    this.mainProgram = createProgram(gl, mainVertexShader, mainFragmentShader);
    this.depthProgram = createProgram(gl, depthVertexShader, depthFragmentShader);
    this.lineProgram = createProgram(gl, lineVertexShader, lineFragmentShader);

    this.vao = gl.createVertexArray()!;
    this.lineVao = gl.createVertexArray()!;
    this.dummyDepth = this.createDummyTexture([255, 255, 255, 255], gl.NEAREST);
    this.dummySlide = this.createDummyTexture([0, 0, 0, 0], gl.LINEAR);
    this.createShadowTargets();
    this.createSlideTextures();

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);

    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    canvas.addEventListener('webglcontextlost', this.handleContextLost);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  private handleContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
    console.warn('WebGL 上下文丢失');
    this.onContextLost?.();
  };

  private handlePointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private handlePointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.camera.yaw -= dx * 0.0052;
    this.camera.pitch = clamp(this.camera.pitch + dy * 0.0042, 0.10, 1.535);
  };

  private handlePointerUp = (): void => {
    this.dragging = false;
  };

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.camera.distance = clamp(this.camera.distance * Math.exp(e.deltaY * 0.0011), 850, 7200);
  };

  setCameraPreset(preset: 'axon' | 'top' | 'worker', state?: ProjectState): void {
    const w = state?.board.width ?? 2400;
    const h = state?.board.height ?? 1200;
    this.camera.target = { x: w / 2, y: h * 0.54, z: 35 };
    if (preset === 'top') {
      this.camera.yaw = 0;
      this.camera.pitch = 1.535;
      this.camera.distance = Math.max(w, h) * 1.35;
    } else if (preset === 'worker') {
      const eye = { x: w / 2, y: -520, z: 560 };
      const t = this.camera.target;
      const dy = eye.y - t.y;
      const dz = eye.z - t.z;
      const horiz = Math.abs(dy);
      this.camera.yaw = 0;
      this.camera.pitch = Math.atan2(dz, horiz);
      this.camera.distance = Math.hypot(horiz, dz);
    } else {
      this.camera.yaw = -0.58;
      this.camera.pitch = 0.64;
      this.camera.distance = Math.max(w, h) * 1.55;
    }
  }

  private createDummyTexture(rgba: [number, number, number, number], filter: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createShadowTargets(): void {
    const gl = this.gl;
    for (let i = 0; i < MAX_PROJ; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, SHADOW_SIZE, SHADOW_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      const rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);

      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.warn('阴影 FBO 不完整', i);
      }
      this.shadowTextures.push(tex);
      this.shadowRenderbuffers.push(rb);
      this.shadowFbos.push(fbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private createSlideTextures(): void {
    const gl = this.gl;
    for (let i = 0; i < MAX_PROJ; i++) {
      const tex = gl.createTexture();
      this.slideTextures[i] = tex;
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(64).fill(0));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
  }

  resize(): void {
    const canvas = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  setAllWiresVisible(all: boolean): void {
    this.allWires = all;
    if (this.state) this.setProject(this.state, this.plan);
  }

  setWorkerStep(order: number | undefined): void {
    this.workerStepOrder = order;
    if (this.state) this.setProject(this.state, this.plan);
  }

  setPlan(plan: GuidePlan | null): void {
    this.plan = plan;
    if (this.state) this.setProject(this.state, plan);
  }

  setProject(state: ProjectState, plan: GuidePlan | null = this.plan): void {
    this.state = state;
    this.plan = plan;
    this.syncSlides(state);
    const workerOrder = this.workerStepOrder ?? plan?.step.order;
    const worker = getStepWorkerRig(state, workerOrder);
    const geom = buildSceneGeometry(state, {
      beforeSequence: this.allWires || !plan ? undefined : plan.step.order,
      worker,
      showProjectorFrusta: true
    });
    this.uploadGeometry(geom);
  }

  private syncSlides(state: ProjectState): void {
    const active = state.projectors.filter((p) => p.enabled).slice(0, MAX_PROJ);
    const signature = active.map((p) => `${p.id}:${p.resolutionW}x${p.resolutionH}:${p.enabled}`).join('|');
    if (signature !== this.slideSignature) {
      this.slides = createSlides(state.projectors).slice(0, MAX_PROJ);
      this.slideSignature = signature;
    } else {
      for (const slide of this.slides) {
        const device = state.projectors.find((p) => p.id === slide.projectorId);
        if (device) slide.rig = createRig(device);
      }
    }
  }

  private uploadGeometry(geom: SceneGeometry): void {
    const gl = this.gl;
    for (const buffer of this.geometryBuffers) gl.deleteBuffer(buffer);
    this.geometryBuffers = [];
    this.triangleCount = geom.triangleCount;
    this.indexCount = geom.indices.length;

    const makeBuffer = (data: BufferSource, target: number = gl.ARRAY_BUFFER): WebGLBuffer => {
      const buffer = gl.createBuffer()!;
      this.geometryBuffers.push(buffer);
      gl.bindBuffer(target, buffer);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return buffer;
    };

    gl.bindVertexArray(this.vao);
    const uploadAttrib = (location: number, data: number[], size: number) => {
      makeBuffer(new Float32Array(data));
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    uploadAttrib(0, geom.positions, 3);
    uploadAttrib(1, geom.normals, 3);
    uploadAttrib(2, geom.colors, 3);
    makeBuffer(new Uint32Array(geom.indices), gl.ELEMENT_ARRAY_BUFFER);
    gl.bindVertexArray(null);

    gl.bindVertexArray(this.lineVao);
    makeBuffer(new Float32Array(geom.linePositions));
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    makeBuffer(new Float32Array(geom.lineColors));
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    this.lineVertexCount = geom.linePositions.length / 3;
    gl.bindVertexArray(null);
  }

  private cameraMatrix(): Float32Array {
    const c = this.camera;
    const cp = Math.cos(c.pitch);
    const eye = v3(
      c.target.x + c.distance * cp * Math.sin(c.yaw),
      c.target.y - c.distance * cp * Math.cos(c.yaw),
      c.target.z + c.distance * Math.sin(c.pitch)
    );
    const view = mat4LookAt(eye, c.target, v3(0, 0, 1));
    const proj = mat4Perspective(50, Math.max(0.1, this.canvas.width / this.canvas.height), 12, 10000);
    return mat4Multiply(proj, view);
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.contextLost || this.gl.isContextLost()) {
      this.contextLost = true;
      return;
    }
    const gl = this.gl;
    this.resize();

    if (this.state) {
      const active = this.state.projectors.filter((p) => p.enabled).slice(0, MAX_PROJ);
      const rigs = active.map(createRig);
      this.paintAndUploadSlides(now, rigs);
      this.renderDepth(rigs);
      this.renderMain(now, rigs);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.035, 0.055, 0.085, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }

    this.frames++;
    if (now - this.lastStats > 600) {
      const fps = Math.round((this.frames * 1000) / Math.max(1, now - this.lastStats));
      this.onStats?.({ fps: Number.isFinite(fps) ? fps : 0, triangles: this.triangleCount });
      this.frames = 0;
      this.lastStats = now;
    }
  };

  private paintAndUploadSlides(now: number, rigs: ProjectorRig[]): void {
    if (!this.state) return;
    const shouldPaint = now - this.lastSlidePaint > 75;
    if (shouldPaint) this.lastSlidePaint = now;
    const gl = this.gl;
    rigs.forEach((rig, i) => {
      const slide = this.slides.find((s) => s.projectorId === rig.device.id);
      const tex = this.slideTextures[i];
      if (!slide || !tex) return;
      slide.rig = rig;
      if (shouldPaint) paintSlide(slide, this.plan, now);
      gl.activeTexture(gl.TEXTURE0 + 4 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      if (shouldPaint || slide.version <= 1) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, slide.canvas);
      }
    });
  }

  private renderDepth(rigs: ProjectorRig[]): void {
    const gl = this.gl;
    gl.useProgram(this.depthProgram);
    gl.bindVertexArray(this.vao);
    const uVP = gl.getUniformLocation(this.depthProgram, 'uVP');
    gl.enable(gl.DEPTH_TEST);
    for (let i = 0; i < rigs.length; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbos[i]);
      gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
      gl.colorMask(true, true, true, true);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(uVP, false, rigs[i].vp);
      if (this.indexCount) gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private renderMain(now: number, rigs: ProjectorRig[]): void {
    const gl = this.gl;
    const state = this.state!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.035, 0.055, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.mainProgram);
    gl.bindVertexArray(this.vao);
    const vp = this.cameraMatrix();
    gl.uniformMatrix4fv(gl.getUniformLocation(this.mainProgram, 'uViewProj'), false, vp);
    const eye = v3(
      this.camera.target.x + this.camera.distance * Math.cos(this.camera.pitch) * Math.sin(this.camera.yaw),
      this.camera.target.y - this.camera.distance * Math.cos(this.camera.pitch) * Math.cos(this.camera.yaw),
      this.camera.target.z + this.camera.distance * Math.sin(this.camera.pitch)
    );
    gl.uniform3f(gl.getUniformLocation(this.mainProgram, 'uCameraPos'), eye.x, eye.y, eye.z);
    const ambient = state.settings.ceilingLightsOn ? state.settings.ambientLux : 24;
    gl.uniform1f(gl.getUniformLocation(this.mainProgram, 'uAmbientLux'), ambient);
    gl.uniform1f(gl.getUniformLocation(this.mainProgram, 'uContrastThreshold'), state.settings.contrastThreshold);
    gl.uniform1f(gl.getUniformLocation(this.mainProgram, 'uTime'), now);
    gl.uniform1i(gl.getUniformLocation(this.mainProgram, 'uHeatmap'), state.settings.showContrastHeatmap ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(this.mainProgram, 'uProjCount'), rigs.length);

    for (let i = 0; i < MAX_PROJ; i++) {
      const depthUnit = i;
      const slideUnit = 4 + i;
      gl.activeTexture(gl.TEXTURE0 + depthUnit);
      gl.bindTexture(gl.TEXTURE_2D, i < rigs.length ? this.shadowTextures[i] : this.dummyDepth);
      gl.uniform1i(gl.getUniformLocation(this.mainProgram, `uDepth${i}`), depthUnit);

      gl.activeTexture(gl.TEXTURE0 + slideUnit);
      gl.bindTexture(gl.TEXTURE_2D, i < rigs.length ? this.slideTextures[i] : this.dummySlide);
      gl.uniform1i(gl.getUniformLocation(this.mainProgram, `uSlide${i}`), slideUnit);

      if (i < rigs.length) {
        const p = rigs[i].device;
        gl.uniformMatrix4fv(gl.getUniformLocation(this.mainProgram, `uProjVP[${i}]`), false, rigs[i].vp);
        gl.uniform3f(gl.getUniformLocation(this.mainProgram, `uEye[${i}]`), rigs[i].eye.x, rigs[i].eye.y, rigs[i].eye.z);
        gl.uniform2f(
          gl.getUniformLocation(this.mainProgram, `uBlendUv[${i}]`),
          state.settings.blendWidthPx / p.resolutionW,
          state.settings.blendWidthPx / p.resolutionH
        );
        gl.uniform1f(gl.getUniformLocation(this.mainProgram, `uLumens[${i}]`), p.lumens);
        gl.uniform1f(gl.getUniformLocation(this.mainProgram, `uThrow[${i}]`), p.throwRatio);
        gl.uniform1f(gl.getUniformLocation(this.mainProgram, `uAspect[${i}]`), p.resolutionW / p.resolutionH);
        gl.uniform1f(gl.getUniformLocation(this.mainProgram, `uNativeContrast[${i}]`), p.nativeContrast);
        gl.uniform1f(gl.getUniformLocation(this.mainProgram, `uPower[${i}]`), Math.min(1.35, p.lumens / 6200));
      } else {
        gl.uniform2f(gl.getUniformLocation(this.mainProgram, `uBlendUv[${i}]`), 0.08, 0.08);
        gl.uniform1f(gl.getUniformLocation(this.mainProgram, `uPower[${i}]`), 0);
      }
    }

    if (this.indexCount) gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    if (this.lineVertexCount > 0) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProgram, 'uViewProj'), false, vp);
      gl.bindVertexArray(this.lineVao);
      gl.lineWidth(1);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    }
    gl.bindVertexArray(null);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
