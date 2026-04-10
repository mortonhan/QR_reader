import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runPdfParseWithFallback, type ParsedPdfResult } from "@/lib/server/pdf-parse";

export const runtime = "nodejs";

type Task = {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: string;
  result?: ParsedPdfResult;
  error?: string;
  createdAt: number;
};

const store = (globalThis as any).__pdfTaskStore || new Map<string, Task>();
(globalThis as any).__pdfTaskStore = store;

async function runTask(taskId: string, tempPath: string) {
  const task = store.get(taskId) as Task | undefined;
  if (!task) return;
  try {
    task.status = "processing";
    task.progress = "服务端正在解析 PDF，请稍候...";
    const result = await runPdfParseWithFallback(tempPath);
    task.result = result;
    task.status = "done";
    task.progress = "解析完成";
  } catch (e) {
    task.status = "failed";
    task.error = e instanceof Error ? e.message : "解析失败";
    task.progress = "解析失败";
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
    setTimeout(() => store.delete(taskId), 30 * 60 * 1000);
  }
}

export async function POST(req: Request) {
  let tempPath = "";
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少 PDF 文件" }, { status: 400 });
    }
    const id = randomUUID();
    tempPath = path.join(os.tmpdir(), `task_${id}.pdf`);
    await fs.writeFile(tempPath, Buffer.from(await file.arrayBuffer()));

    const task: Task = {
      id,
      status: "queued",
      progress: "任务已创建，等待处理...",
      createdAt: Date.now(),
    };
    store.set(id, task);
    void runTask(id, tempPath);
    return NextResponse.json({ taskId: id }, { status: 200 });
  } catch (e) {
    if (tempPath) await fs.unlink(tempPath).catch(() => undefined);
    return NextResponse.json({ error: e instanceof Error ? e.message : "创建任务失败" }, { status: 500 });
  }
}

