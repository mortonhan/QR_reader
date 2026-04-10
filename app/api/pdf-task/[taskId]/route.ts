import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await ctx.params;
  const store = (globalThis as any).__pdfTaskStore as
    | Map<
        string,
        {
          id: string;
          status: "queued" | "processing" | "done" | "failed";
          progress: string;
          result?: { results: any[]; pagePreviews?: Record<string, string> };
          error?: string;
        }
      >
    | undefined;
  if (!store || !store.has(taskId)) {
    return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
  }
  const task = store.get(taskId)!;
  return NextResponse.json(
    {
      id: task.id,
      status: task.status,
      progress: task.progress,
      error: task.error,
      result: task.result,
    },
    { status: 200 }
  );
}

