const VEHICLE_CLASSES = new Set(['car', 'truck', 'bus', 'motorcycle', 'bicycle', 'van']);

const sourceImageInput = document.getElementById('sourceImage');
const modelQualitySelect = document.getElementById('modelQuality');
const maskModeSelect = document.getElementById('maskMode');
const maskThresholdInput = document.getElementById('maskThreshold');
const autoCropInput = document.getElementById('autoCrop');
const cropPaddingInput = document.getElementById('cropPadding');
const segmentBtn = document.getElementById('segmentBtn');
const iconSizeSelect = document.getElementById('iconSize');
const zoomInput = document.getElementById('zoom');
const offsetXInput = document.getElementById('offsetX');
const offsetYInput = document.getElementById('offsetY');
const lightsEnabledInput = document.getElementById('lightsEnabled');
const groupPatternAInput = document.getElementById('groupPatternA');
const groupPatternBInput = document.getElementById('groupPatternB');
const fpsInput = document.getElementById('fps');
const lightIntensityInput = document.getElementById('lightIntensity');
const selectedLightInput = document.getElementById('selectedLight');
const lightXInput = document.getElementById('lightX');
const lightYInput = document.getElementById('lightY');
const lightColorInput = document.getElementById('lightColor');
const lightGroupInput = document.getElementById('lightGroup');
const lightPatternModeInput = document.getElementById('lightPatternMode');
const downloadPngBtn = document.getElementById('downloadPngBtn');
const downloadGifBtn = document.getElementById('downloadGifBtn');
const statusEl = document.getElementById('status');

const previewCanvas = document.getElementById('previewCanvas');
const previewCtx = previewCanvas.getContext('2d');
const miniPreview = document.getElementById('miniPreview');
const miniCtx = miniPreview.getContext('2d');

let sourceBitmap = null;
let segmentedCanvas = null;
let cutoutCanvas = null;
let model = null;
let modelNameLoaded = '';
let animationHandle = 0;
let animationStart = performance.now();

const lights = [
  { x: 0.36, y: 0.25, color: '#ff0000', group: 'A', mode: 'group' },
  { x: 0.64, y: 0.25, color: '#2f6bff', group: 'B', mode: 'group' },
  { x: 0.5, y: 0.25, color: '#ffffff', group: 'A', mode: 'pulse' },
  { x: 0.5, y: 0.35, color: '#ffbf00', group: 'B', mode: 'group' },
];

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = `status ${isError ? 'error' : 'ok'}`;
}

function hexToRgba(hex, alpha = 1) {
  const h = hex.replace('#', '').trim();
  const safe = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(safe, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
    a: Math.max(0, Math.min(1, alpha)),
  };
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

async function loadBitmapFromFile(file) {
  const blobUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = blobUrl;
    await image.decode();
    return await createImageBitmap(image);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function drawChecker(ctx, w, h) {
  const size = 16;
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      const isDark = ((x / size + y / size) & 1) === 0;
      ctx.fillStyle = isDark ? '#d8dde3' : '#eceff3';
      ctx.fillRect(x, y, size, size);
    }
  }
}

async function ensureModel() {
  const requested = modelQualitySelect.value;
  if (model && modelNameLoaded === requested) return model;
  setStatus(`Loading segmentation model (${requested})...`);
  model = await deeplab.load({ base: requested, quantizationBytes: 2 });
  modelNameLoaded = requested;
  setStatus(`Model ready (${requested}).`);
  return model;
}

function shouldKeepClass(className, mode) {
  if (mode === 'foreground') return className !== 'background';
  return VEHICLE_CLASSES.has(String(className || '').toLowerCase());
}

function cropToOpaqueBounds(canvas, paddingRatio = 0) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);

  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const a = data.data[(y * canvas.width + x) * 4 + 3];
      if (a > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const pad = Math.round(Math.max(canvas.width, canvas.height) * clamp01(paddingRatio));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(canvas.width - 1, maxX + pad);
  maxY = Math.min(canvas.height - 1, maxY + pad);

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d');
  outCtx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return out;
}

function activeCutoutCanvas() {
  if (!segmentedCanvas) return null;
  if (!autoCropInput.checked) return segmentedCanvas;
  return cropToOpaqueBounds(segmentedCanvas, Number(cropPaddingInput.value) || 0);
}

async function segmentVehicle() {
  if (!sourceBitmap) {
    setStatus('Please upload an image first.', true);
    return;
  }

  const loadedModel = await ensureModel();
  setStatus('Running segmentation...');

  const inputCanvas = document.createElement('canvas');
  inputCanvas.width = sourceBitmap.width;
  inputCanvas.height = sourceBitmap.height;
  const inputCtx = inputCanvas.getContext('2d', { willReadFrequently: true });
  inputCtx.drawImage(sourceBitmap, 0, 0);

  const segmentation = await loadedModel.segment(inputCanvas);
  const map = segmentation.segmentationMap;
  const legend = segmentation.legend || {};
  const sourceData = inputCtx.getImageData(0, 0, inputCanvas.width, inputCanvas.height);
  const out = inputCtx.createImageData(inputCanvas.width, inputCanvas.height);

  const mode = maskModeSelect.value;
  const threshold = Number(maskThresholdInput.value) || 0;

  let kept = 0;

  for (let i = 0; i < map.length; i += 1) {
    const classId = map[i];
    const className = legend[classId] || '';
    const keep = shouldKeepClass(className, mode);
    const p = i * 4;
    out.data[p] = sourceData.data[p];
    out.data[p + 1] = sourceData.data[p + 1];
    out.data[p + 2] = sourceData.data[p + 2];
    out.data[p + 3] = keep ? sourceData.data[p + 3] : 0;
    if (keep) kept += 1;
  }

  for (let y = 0; y < sourceHeight; y += 1) {
    const mapY = Math.min(mapHeight - 1, Math.max(0, Math.floor((y / sourceHeight) * mapHeight)));
    for (let x = 0; x < sourceWidth; x += 1) {
      const mapX = Math.min(mapWidth - 1, Math.max(0, Math.floor((x / sourceWidth) * mapWidth)));
      const classId = labelMap[mapY * mapWidth + mapX];
      const className = labels[classId] || '';
      const keep = shouldKeepClass(className, mode);
      const p = (y * sourceWidth + x) * 4;
      out.data[p] = sourceData.data[p];
      out.data[p + 1] = sourceData.data[p + 1];
      out.data[p + 2] = sourceData.data[p + 2];
      out.data[p + 3] = keep ? sourceData.data[p + 3] : 0;
      if (keep) kept += 1;
    }
  }

  if (threshold > 0) {
    for (let i = 3; i < out.data.length; i += 4) {
      if (out.data[i] < threshold) out.data[i] = 0;
    }
  }

  segmentedCanvas = document.createElement('canvas');
  segmentedCanvas.width = inputCanvas.width;
  segmentedCanvas.height = inputCanvas.height;
  const ctx = segmentedCanvas.getContext('2d');
  ctx.putImageData(out, 0, 0);

  cutoutCanvas = activeCutoutCanvas();
  if (!cutoutCanvas) {
    setStatus('No visible object found after segmentation.', true);
    return;
  }

  setStatus('Background removed. Full segmented image is shown first; enable auto-crop when ready.');
  renderPreview(performance.now());
}

function frameLightPhase(frameIndex, totalFrames, pattern) {
  const t = (frameIndex % totalFrames) / totalFrames;
  if (pattern === 'pulse') {
    const pulse = Math.max(0, Math.sin(t * Math.PI * 2));
    return { left: pulse, right: pulse };
  }
  if (pattern === 'simultaneous') {
    const on = Math.sin(t * Math.PI * 2) > 0 ? 1 : 0;
    return { left: on, right: on };
  }
  if (pattern === 'sweep') {
    const sweep = (Math.sin(t * Math.PI * 2) + 1) / 2;
    return { left: 1 - sweep, right: sweep };
  }
  const alt = Math.sin(t * Math.PI * 2) > 0 ? 1 : 0;
  return { left: alt, right: 1 - alt };
}

function drawBeacon(ctx, x, y, color, intensity, radius) {
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  const c = hexToRgba(color, intensity);
  glow.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.95 * c.a})`);
  glow.addColorStop(0.5, `rgba(${c.r},${c.g},${c.b},${0.35 * c.a})`);
  glow.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function syncLightEditorFromSelection() {
  const idx = Math.max(0, Math.min(lights.length - 1, Number(selectedLightInput.value) || 0));
  const light = lights[idx];
  lightXInput.value = String(light.x);
  lightYInput.value = String(light.y);
  lightColorInput.value = light.color;
  lightGroupInput.value = light.group;
  lightPatternModeInput.value = light.mode;
}

function updateSelectedLight() {
  const idx = Math.max(0, Math.min(lights.length - 1, Number(selectedLightInput.value) || 0));
  const light = lights[idx];
  light.x = clamp01(lightXInput.value);
  light.y = clamp01(lightYInput.value);
  light.color = lightColorInput.value;
  light.group = lightGroupInput.value === 'B' ? 'B' : 'A';
  light.mode = lightPatternModeInput.value;
}

function renderToCanvas(targetCanvas, frameIndex = 0, totalFrames = 12) {
  const ctx = targetCanvas.getContext('2d');
  const size = Number(iconSizeSelect.value) || 36;
  targetCanvas.width = size;
  targetCanvas.height = size;
  ctx.clearRect(0, 0, size, size);

  cutoutCanvas = activeCutoutCanvas();
  if (!cutoutCanvas) return;

  const zoom = Number(zoomInput.value) || 1;
  const offsetX = Number(offsetXInput.value) || 0;
  const offsetY = Number(offsetYInput.value) || 0;

  const fit = Math.min(size / cutoutCanvas.width, size / cutoutCanvas.height);
  const drawW = cutoutCanvas.width * fit * zoom;
  const drawH = cutoutCanvas.height * fit * zoom;
  const dx = (size - drawW) / 2 + offsetX * size * 0.5;
  const dy = (size - drawH) / 2 + offsetY * size * 0.5;

  ctx.drawImage(cutoutCanvas, dx, dy, drawW, drawH);

  if (lightsEnabledInput.checked) {
    const intensity = clamp01(lightIntensityInput.value);
    const radius = Math.max(2, size * 0.2);
    const groupPhaseA = frameLightPhase(frameIndex, totalFrames, groupPatternAInput.value);
    const groupPhaseB = frameLightPhase(frameIndex, totalFrames, groupPatternBInput.value);

    lights.forEach((light) => {
      const pair = light.mode === 'group'
        ? (light.group === 'B' ? groupPhaseB : groupPhaseA)
        : frameLightPhase(frameIndex, totalFrames, light.mode);
      const brightness = light.group === 'B' ? pair.right : pair.left;
      if (brightness <= 0.01) return;
      drawBeacon(ctx, size * clamp01(light.x), size * clamp01(light.y), light.color, intensity * brightness, radius);
    });

    const activeIndex = Math.max(0, Math.min(lights.length - 1, Number(selectedLightInput.value) || 0));
    const selected = lights[activeIndex];
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(size * clamp01(selected.x), size * clamp01(selected.y), Math.max(2, size * 0.07), 0, Math.PI * 2);
    ctx.stroke();
  }
}

function renderPreview(ts) {
  if (!previewCtx || !miniCtx) return;

  const elapsed = Math.max(0, ts - animationStart);
  const fps = Math.max(2, Number(fpsInput.value) || 8);
  const frame = Math.floor((elapsed / 1000) * fps) % 12;

  drawChecker(previewCtx, previewCanvas.width, previewCanvas.height);

  const temp = document.createElement('canvas');
  renderToCanvas(temp, frame, 12);

  const drawSize = Math.min(previewCanvas.width, previewCanvas.height) * 0.72;
  const dx = (previewCanvas.width - drawSize) / 2;
  const dy = (previewCanvas.height - drawSize) / 2;
  previewCtx.drawImage(temp, dx, dy, drawSize, drawSize);

  miniCtx.clearRect(0, 0, miniPreview.width, miniPreview.height);
  miniCtx.imageSmoothingEnabled = false;
  miniCtx.drawImage(temp, 0, 0, miniPreview.width, miniPreview.height);
}

function loop(ts) {
  renderPreview(ts);
  animationHandle = requestAnimationFrame(loop);
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportPng() {
  if (!cutoutCanvas) {
    setStatus('Please remove background first.', true);
    return;
  }
  const canvas = document.createElement('canvas');
  renderToCanvas(canvas, 0, 1);
  canvas.toBlob((blob) => {
    if (!blob) {
      setStatus('Failed to create PNG.', true);
      return;
    }
    triggerDownload(blob, 'vehicle-icon.png');
    setStatus('PNG downloaded.');
  }, 'image/png');
}

function exportGif() {
  if (!cutoutCanvas) {
    setStatus('Please remove background first.', true);
    return;
  }
  if (typeof GIF === 'undefined') {
    setStatus('GIF library failed to load.', true);
    return;
  }

  const size = Number(iconSizeSelect.value) || 36;
  const fps = Math.max(2, Number(fpsInput.value) || 8);
  const frameDelay = Math.round(1000 / fps);

  const gif = new GIF({
    workers: 2,
    quality: 8,
    transparent: 0x00FF00,
    width: size,
    height: size,
    workerScript: 'https://cdn.jsdelivr.net/npm/gif.js.optimized@1.0.1/dist/gif.worker.js',
  });

  setStatus('Rendering GIF...');

  for (let i = 0; i < 12; i += 1) {
    const frameCanvas = document.createElement('canvas');
    renderToCanvas(frameCanvas, i, 12);

    const ctx = frameCanvas.getContext('2d');
    const keyColor = '#00ff00';
    const composited = document.createElement('canvas');
    composited.width = size;
    composited.height = size;
    const cctx = composited.getContext('2d');
    cctx.fillStyle = keyColor;
    cctx.fillRect(0, 0, size, size);
    cctx.drawImage(frameCanvas, 0, 0);

    gif.addFrame(composited, { copy: true, delay: frameDelay });
    ctx.clearRect(0, 0, frameCanvas.width, frameCanvas.height);
  }

  gif.on('finished', (blob) => {
    triggerDownload(blob, 'vehicle-icon-responding.gif');
    setStatus('GIF downloaded.');
  });

  gif.on('abort', () => {
    setStatus('GIF export aborted.', true);
  });

  gif.render();
}

sourceImageInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    sourceBitmap = await loadBitmapFromFile(file);
    segmentedCanvas = null;
    cutoutCanvas = null;
    autoCropInput.checked = false;
    setStatus('Image loaded. Click "Remove Background".');
    renderPreview(performance.now());
  } catch (err) {
    setStatus(`Failed to load image: ${err.message || err}`, true);
  }
});

segmentBtn.addEventListener('click', () => {
  segmentVehicle().catch((err) => {
    console.error(err);
    setStatus(`Segmentation failed: ${err.message || err}`, true);
  });
});

[iconSizeSelect, zoomInput, offsetXInput, offsetYInput, lightsEnabledInput, groupPatternAInput, groupPatternBInput, fpsInput, lightIntensityInput, maskThresholdInput, autoCropInput, cropPaddingInput].forEach((el) => {
  el.addEventListener('input', () => renderPreview(performance.now()));
  el.addEventListener('change', () => renderPreview(performance.now()));
});

[lightXInput, lightYInput, lightColorInput, lightGroupInput, lightPatternModeInput].forEach((el) => {
  el.addEventListener('input', () => {
    updateSelectedLight();
    renderPreview(performance.now());
  });
  el.addEventListener('change', () => {
    updateSelectedLight();
    renderPreview(performance.now());
  });
});

selectedLightInput.addEventListener('change', () => {
  syncLightEditorFromSelection();
  renderPreview(performance.now());
});

previewCanvas.addEventListener('click', (event) => {
  const rect = previewCanvas.getBoundingClientRect();
  const px = ((event.clientX - rect.left) / rect.width) * previewCanvas.width;
  const py = ((event.clientY - rect.top) / rect.height) * previewCanvas.height;
  const drawSize = Math.min(previewCanvas.width, previewCanvas.height) * 0.72;
  const dx = (previewCanvas.width - drawSize) / 2;
  const dy = (previewCanvas.height - drawSize) / 2;
  if (px < dx || py < dy || px > dx + drawSize || py > dy + drawSize) return;

  lightXInput.value = String(clamp01((px - dx) / drawSize));
  lightYInput.value = String(clamp01((py - dy) / drawSize));
  updateSelectedLight();
  renderPreview(performance.now());
});

downloadPngBtn.addEventListener('click', exportPng);
downloadGifBtn.addEventListener('click', exportGif);

animationHandle = requestAnimationFrame(loop);
window.addEventListener('beforeunload', () => {
  if (animationHandle) cancelAnimationFrame(animationHandle);
});

syncLightEditorFromSelection();
setStatus('Upload an image to begin.');
