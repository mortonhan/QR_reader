import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runPdfParseWithFallback } from "@/lib/server/pdf-parse";

export const runtime = "nodejs";

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

    const parsed = await runPdfParseWithFallback(tempFilePath);
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

