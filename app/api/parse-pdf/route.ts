import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export const runtime = "nodejs";

type ParsedRow = {
  pageNumber: number;
  indexInPage: number;
  text: string;
  positionLabel: string;
};

const PY_SCRIPT = `
import fitz
import cv2
import numpy as np
import json
import sys
import base64

def pos_label(points, w, h):
    try:
        p = points.reshape(-1, 2)
        cx = float(np.mean(p[:,0]))
        cy = float(np.mean(p[:,1]))
        if 0.35*w <= cx <= 0.65*w and 0.35*h <= cy <= 0.65*h:
            return "居中"
        left = cx < w/2
        top = cy < h/2
        if left and top: return "左上"
        if (not left) and top: return "右上"
        if left and (not top): return "左下"
        return "右下"
    except Exception:
        return "未知"

pdf_path = sys.argv[1]
doc = fitz.open(pdf_path)
det = cv2.QRCodeDetector()
all_rows = []
page_previews = {}

for page_idx, page in enumerate(doc, start=1):
    page_rows = []
    for zoom in [2.5, 3.0, 3.5, 4.0]:
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
        bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        ok, decoded_info, points, _ = det.detectAndDecodeMulti(bgr)
        if not ok or decoded_info is None:
            continue

        seen = set()
        page_rows = []
        for i, raw in enumerate(decoded_info):
            txt = (raw or "").strip()
            if not txt or txt in seen:
                continue
            seen.add(txt)
            label = "未知"
            if points is not None and len(points) > i:
                label = pos_label(points[i], bgr.shape[1], bgr.shape[0])
            page_rows.append({
                "pageNumber": page_idx,
                "indexInPage": len(page_rows) + 1,
                "text": txt,
                "positionLabel": label
            })
        if len(page_rows) > 0:
            # 仅对识别到二维码的页面生成缩略图，减小返回体积
            thumb = page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2), alpha=False)
            thumb_img = np.frombuffer(thumb.samples, dtype=np.uint8).reshape(thumb.h, thumb.w, thumb.n)
            thumb_bgr = cv2.cvtColor(thumb_img, cv2.COLOR_RGB2BGR)
            ok_jpg, jpg_buf = cv2.imencode('.jpg', thumb_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
            if ok_jpg:
                b64 = base64.b64encode(jpg_buf.tobytes()).decode('ascii')
                page_previews[str(page_idx)] = "data:image/jpeg;base64," + b64
            break

    all_rows.extend(page_rows)

print(json.dumps({"results": all_rows, "pagePreviews": page_previews}, ensure_ascii=False))
`;

function runPython(
  pythonBin: string,
  pdfPath: string
): Promise<{ results: ParsedRow[]; pagePreviews?: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const py = spawn(pythonBin, ["-c", PY_SCRIPT, pdfPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    py.stdout.on("data", (d) => (out += d.toString()));
    py.stderr.on("data", (d) => (err += d.toString()));

    py.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err || `python exit code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as {
          results: ParsedRow[];
          pagePreviews?: Record<string, string>;
        };
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function runPythonWithFallback(pdfPath: string) {
  const candidates = [
    process.env.PYTHON_BIN || "",
    "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
    "/Users/yumo/miniconda3/bin/python3",
    "python3",
  ].filter(Boolean);

  let lastErr: unknown = null;
  for (const bin of candidates) {
    try {
      return await runPython(bin, pdfPath);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("未找到可用 Python 环境");
}

export async function POST(req: Request) {
  let tempFilePath = "";
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ results: [], error: "缺少 PDF 文件" }, { status: 400 });
    }
    if (file.type && file.type !== "application/pdf") {
      return NextResponse.json({ results: [], error: "仅支持 PDF 文件" }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    tempFilePath = path.join(os.tmpdir(), `qr_${randomUUID()}.pdf`);
    await fs.writeFile(tempFilePath, bytes);

    const parsed = await runPythonWithFallback(tempFilePath);
    return NextResponse.json(parsed, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF 解析失败";
    return NextResponse.json({ results: [], error: `PDF 解析失败: ${message}` }, { status: 500 });
  } finally {
    if (tempFilePath) {
      await fs.unlink(tempFilePath).catch(() => undefined);
    }
  }
}

