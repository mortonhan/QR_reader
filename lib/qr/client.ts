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
  onPageResults?: (rows: QrParseResult[]) => void;
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

async function scanCanvasForMultipleQRCodes(
  canvas: HTMLCanvasElement,
  opts?: { maxCount?: number; fastMode?: boolean }
) {
  const maxCount = opts?.maxCount ?? 12;
  const fastMode = opts?.fastMode ?? false;
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

  const tryDecode = (imageData: ImageData) =>
    jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "attemptBoth",
    });

  const toBinary = (imageData: ImageData, threshold: number) => {
    const d = new Uint8ClampedArray(imageData.data);
    for (let i = 0; i < d.length; i += 4) {
      const gray = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const v = gray >= threshold ? 255 : 0;
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    return new ImageData(d, imageData.width, imageData.height);
  };

  const tryDecodeWithPreprocess = (imageData: ImageData) => {
    const direct = tryDecode(imageData);
    if (direct) return direct;
    if (fastMode) return null;
    // 对“发灰/压缩”的 PDF 图像做多阈值二值化兜底
    const thresholds = [90, 110, 128, 150, 170];
    for (const t of thresholds) {
      const code = tryDecode(toBinary(imageData, t));
      if (code) return code;
    }
    return null;
  };

  // 先使用 jsQR 多次扫描（每次抹除一个已识别区域）
  // 每次 jsQR 识别出一个二维码后，把该区域涂白，再继续识别下一条。
  for (let i = 0; i < maxCount; i++) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let code = tryDecodeWithPreprocess(imageData);

    // 若整页扫描失败，再尝试“宫格分块”扫描，适配二维码很小或在边角的情况
    if (!code && !fastMode) {
      const gridSizes = [2, 3];
      for (const grid of gridSizes) {
        const tileW = Math.floor(canvas.width / grid);
        const tileH = Math.floor(canvas.height / grid);
        for (let gy = 0; gy < grid; gy++) {
          for (let gx = 0; gx < grid; gx++) {
            const sx = gx * tileW;
            const sy = gy * tileH;
            const sw = gx === grid - 1 ? canvas.width - sx : tileW;
            const sh = gy === grid - 1 ? canvas.height - sy : tileH;
            if (sw < 40 || sh < 40) continue;
            const tile = ctx.getImageData(sx, sy, sw, sh);
            const found = tryDecodeWithPreprocess(tile);
            if (found) {
              // 把分块坐标转换回整页坐标
              code = {
                ...found,
                location: {
                  topLeftCorner: {
                    x: found.location.topLeftCorner.x + sx,
                    y: found.location.topLeftCorner.y + sy,
                  },
                  topRightCorner: {
                    x: found.location.topRightCorner.x + sx,
                    y: found.location.topRightCorner.y + sy,
                  },
                  bottomLeftCorner: {
                    x: found.location.bottomLeftCorner.x + sx,
                    y: found.location.bottomLeftCorner.y + sy,
                  },
                  bottomRightCorner: {
                    x: found.location.bottomRightCorner.x + sx,
                    y: found.location.bottomRightCorner.y + sy,
                  },
                },
              } as typeof found;
              break;
            }
          }
          if (code) break;
        }
        if (code) break;
      }
    }

    if (!code) break;

    const pos = getPositionLabelByLocation(canvas.width, canvas.height, code.location);
    const text = (code.data ?? "").trim();
    if (!text) {
      // 避免卡在同一处“空数据误识别”
      maskFoundQrOnCanvas(ctx, code.location);
      continue;
    }
    results.push({
      text,
      location: code.location,
      positionLabel: pos,
    });
    maskFoundQrOnCanvas(ctx, code.location);
  }

  // 若 jsQR 为空，则使用浏览器原生 BarcodeDetector 兜底。
  // 这在部分 PDF 渲染图上识别率更高。
  if (
    results.length === 0 &&
    "BarcodeDetector" in globalThis &&
    typeof (globalThis as any).BarcodeDetector === "function"
  ) {
    try {
      const detector = new (globalThis as any).BarcodeDetector({
        formats: ["qr_code"],
      });
      const barcodes: Array<{
        rawValue?: string;
        cornerPoints?: Array<{ x: number; y: number }>;
      }> = await detector.detect(canvas);

      for (const b of barcodes) {
        const text = (b.rawValue ?? "").trim();
        const corners = b.cornerPoints ?? [];
        if (!text || corners.length < 4) continue;
        const location = {
          topLeftCorner: { x: corners[0].x, y: corners[0].y },
          topRightCorner: { x: corners[1].x, y: corners[1].y },
          bottomRightCorner: { x: corners[2].x, y: corners[2].y },
          bottomLeftCorner: { x: corners[3].x, y: corners[3].y },
        };
        results.push({
          text,
          location,
          positionLabel: getPositionLabelByLocation(canvas.width, canvas.height, location),
        });
      }
    } catch {
      // 忽略原生识别失败，继续走后续兜底
    }
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

async function canvasToJpegFile(canvas: HTMLCanvasElement, name: string) {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.95)
  );
  if (!blob) return null;
  return new File([blob], name, { type: "image/jpeg" });
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

  const multi = await scanCanvasForMultipleQRCodes(canvas, { maxCount: 12 });
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
  const onPageResults = options?.onPageResults;
  const maxPerPage = options?.maxPerPage ?? 12;
  onProgress?.("正在上传 PDF 到服务端解析...");

  const form = new FormData();
  form.append("file", file, file.name || "upload.pdf");

  const res = await fetch("/api/parse-pdf", {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    onProgress?.("PDF 解析失败");
    return [];
  }

  const data = (await res.json()) as {
    results?: Array<{
      pageNumber: number;
      indexInPage: number;
      text: string;
      positionLabel: string;
    }>;
    pagePreviews?: Record<string, string>;
  };
  const pagePreviews = data.pagePreviews ?? {};
  const rows = (data.results ?? [])
    .filter((r) => (r.text ?? "").trim().length > 0)
    .map((r) => {
      const indexInPage = r.indexInPage > maxPerPage ? maxPerPage : r.indexInPage;
      const row: QrParseResult = {
        sourceType: "pdf",
        pageNumber: r.pageNumber,
        indexInPage,
        pageLabel: `第${r.pageNumber}页-第${indexInPage}个（${r.positionLabel || "未知"}）`,
        text: r.text.trim(),
        positionLabel: r.positionLabel || "未知",
        previewUrl: pagePreviews[String(r.pageNumber)],
      };
      return row;
    });

  if (rows.length > 0) onPageResults?.(rows);
  onProgress?.("PDF 解析完成，正在整理结果...");
  return rows;
}

