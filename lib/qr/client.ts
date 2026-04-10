import jsQR from "jsqr";

// 注意：这个文件只用于浏览器端（前端）解析二维码。
// 在 Next.js App Router 中，请确保仅在 "use client" 的组件里引入它。

export type QrParseResult =
  | {
      sourceType: "image";
      index: number; // 图片结果用序号即可
      pageLabel: string; // 为了表格统一字段，这里也给一个 label
      text: string;
      positionLabel: string; // 简单位置特征（左上/居中/… 或 第N个）
      previewUrl?: string; // 结果对应的预览图（图片文件本身）
    }
  | {
      sourceType: "pdf";
      pageNumber: number;
      indexInPage: number;
      pageLabel: string; // 例：第2页-第1个（右上）
      text: string;
      positionLabel: string;
      previewUrl?: string; // 结果对应页的渲染图
    };

type ProgressOptions = {
  onProgress?: (message: string) => void;
  // 为了避免死循环或极端情况下过慢，限制每一页最多识别多少个二维码
  maxPerPage?: number;
  // PDF 渲染缩放倍数（越大越清晰，但越慢）
  pdfScale?: number;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPositionLabelByLocation(
  width: number,
  height: number,
  location: {
    topLeftCorner: { x: number; y: number };
    topRightCorner: { x: number; y: number };
    bottomLeftCorner: { x: number; y: number };
    bottomRightCorner: { x: number; y: number };
  }
) {
  const xs = [
    location.topLeftCorner.x,
    location.topRightCorner.x,
    location.bottomLeftCorner.x,
    location.bottomRightCorner.x,
  ];
  const ys = [
    location.topLeftCorner.y,
    location.topRightCorner.y,
    location.bottomLeftCorner.y,
    location.bottomRightCorner.y,
  ];

  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

  // “居中”判定：中心点落在中间 30% 的区域
  const centerX1 = width * 0.35;
  const centerX2 = width * 0.65;
  const centerY1 = height * 0.35;
  const centerY2 = height * 0.65;
  if (cx >= centerX1 && cx <= centerX2 && cy >= centerY1 && cy <= centerY2) {
    return "居中";
  }

  const left = cx < width / 2;
  const top = cy < height / 2;
  if (left && top) return "左上";
  if (!left && top) return "右上";
  if (left && !top) return "左下";
  return "右下";
}

function maskFoundQrOnCanvas(
  ctx: CanvasRenderingContext2D,
  location: {
    topLeftCorner: { x: number; y: number };
    topRightCorner: { x: number; y: number };
    bottomLeftCorner: { x: number; y: number };
    bottomRightCorner: { x: number; y: number };
  }
) {
  const xs = [
    location.topLeftCorner.x,
    location.topRightCorner.x,
    location.bottomLeftCorner.x,
    location.bottomRightCorner.x,
  ];
  const ys = [
    location.topLeftCorner.y,
    location.topRightCorner.y,
    location.bottomLeftCorner.y,
    location.bottomRightCorner.y,
  ];

  const minX = Math.floor(Math.min(...xs));
  const maxX = Math.ceil(Math.max(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));

  // 为了防止下一次扫描仍然命中同一个二维码，给一点 padding
  const pad = 12;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(ctx.canvas.width - x, maxX - minX + pad * 2);
  const h = Math.min(ctx.canvas.height - y, maxY - minY + pad * 2);

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function scanCanvasForMultipleQRCodes(
  canvas: HTMLCanvasElement,
  opts?: { maxCount?: number }
) {
  const maxCount = opts?.maxCount ?? 12;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];

  const results: Array<{
    text: string;
    location: {
      topLeftCorner: { x: number; y: number };
      topRightCorner: { x: number; y: number };
      bottomLeftCorner: { x: number; y: number };
      bottomRightCorner: { x: number; y: number };
    };
    positionLabel: string;
  }> = [];

  // 为了“多二维码识别”，我们采用一个简单可理解的策略：
  // 每次 jsQR 识别出一个二维码后，把该区域涂白，再继续识别下一条。
  for (let i = 0; i < maxCount; i++) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });
    if (!code) break;

    const pos = getPositionLabelByLocation(canvas.width, canvas.height, code.location);
    results.push({
      text: code.data,
      location: code.location,
      positionLabel: pos,
    });
    maskFoundQrOnCanvas(ctx, code.location);
  }

  // 去重（有时会出现重复识别）
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.text}-${r.positionLabel}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function upscaleCanvas(source: HTMLCanvasElement, ratio: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(source.width * ratio));
  canvas.height = Math.max(1, Math.floor(source.height * ratio));
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function fileToImageBitmap(file: File) {
  // createImageBitmap 在现代浏览器性能更好
  const blob = file.slice(0, file.size, file.type);
  return await createImageBitmap(blob);
}

export async function parseImageFileQRCodes(file: File): Promise<QrParseResult[]> {
  const bmp = await fileToImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(bmp, 0, 0);

  const multi = scanCanvasForMultipleQRCodes(canvas, { maxCount: 12 });
  if (multi.length === 0) return [];

  return multi.map((m, idx) => ({
    sourceType: "image",
    index: idx + 1,
    pageLabel: `第1页-第${idx + 1}个（${m.positionLabel}）`,
    text: m.text,
    positionLabel: m.positionLabel,
  }));
}

let pdfWorkerReady = false;

async function ensurePdfWorker() {
  if (pdfWorkerReady) return;

  // 在 Next.js 16 + Turbopack 环境下，直接设置 workerSrc 可能报：
  // "Invalid `workerSrc` type."
  // 因此这里改用 workerPort 方式，兼容性更好。
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const worker = new Worker(
    new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url),
    { type: "module" }
  );
  (pdfjsLib as any).GlobalWorkerOptions.workerPort = worker;
  pdfWorkerReady = true;
}

export async function parsePdfFileQRCodes(
  file: File,
  options?: ProgressOptions
): Promise<QrParseResult[]> {
  const onProgress = options?.onProgress;
  const maxPerPage = options?.maxPerPage ?? 12;
  const pdfScale = options?.pdfScale ?? 2;

  await ensurePdfWorker();
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const buffer = await file.arrayBuffer();
  const loadingTask = (pdfjsLib as any).getDocument({
    data: buffer,
    // 某些浏览器 + PDF 组合下，ImageDecoder 路径可能导致图像还没就绪就被读取
    // 关闭后更稳定（代价是略慢一点）。
    isImageDecoderSupported: false,
  });
  const pdf = await loadingTask.promise;

  const all: QrParseResult[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    onProgress?.(`正在解析 PDF 第 ${pageNumber} 页...`);
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: pdfScale });

    // 离屏 canvas：不需要渲染到页面上
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;

    await page.render({
      canvasContext: ctx,
      viewport,
    }).promise;
    // 让异步图片依赖有一点时间落盘到 canvas，减少 “Dependent image isn't ready yet”
    await sleep(80);
    const pagePreviewUrl = canvas.toDataURL("image/png");

    let multi = scanCanvasForMultipleQRCodes(canvas, { maxCount: maxPerPage });
    // 兜底：当二维码很小或页面分辨率不够时，放大后再扫一次
    if (multi.length === 0) {
      const x15 = upscaleCanvas(canvas, 1.5);
      multi = scanCanvasForMultipleQRCodes(x15, { maxCount: maxPerPage });
    }
    if (multi.length === 0) {
      const x2 = upscaleCanvas(canvas, 2);
      multi = scanCanvasForMultipleQRCodes(x2, { maxCount: maxPerPage });
    }

    if (multi.length === 0) {
      onProgress?.(`第 ${pageNumber} 页未识别到二维码，继续下一页...`);
      continue;
    }

    multi.forEach((m, idx) => {
      const indexInPage = idx + 1;
      const pageLabel = `第${pageNumber}页-第${indexInPage}个（${m.positionLabel}）`;
      all.push({
        sourceType: "pdf",
        pageNumber,
        indexInPage,
        pageLabel,
        text: m.text,
        positionLabel: m.positionLabel,
        previewUrl: pagePreviewUrl,
      });
    });
  }

  onProgress?.("PDF 解析完成，正在整理结果...");
  return all;
}

