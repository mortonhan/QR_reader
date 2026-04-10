"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import {
  Check,
  ClipboardCopy,
  Download,
  Expand,
  FileText,
  Image as ImageIcon,
  Loader2,
  Scan,
  Trash2,
  X,
} from "lucide-react";
import type { QrParseResult } from "@/lib/qr/client";
import { parseImageFileQRCodes, parsePdfFileQRCodes } from "@/lib/qr/client";

type Row = QrParseResult & {
  content: string;
};

function isProbablyUrl(text: string) {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function csvEscape(value: string) {
  const v = value ?? "";
  if (/[,"\n]/.test(v)) return `"${v.replaceAll('"', '""')}"`;
  return v;
}

function isSupportedUploadFile(file: File) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  const byName =
    name.endsWith(".pdf") ||
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg");
  const byType =
    type === "application/pdf" ||
    type === "image/png" ||
    type === "image/jpeg";
  return byName || byType;
}

function isPdfFile(file: File) {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  return name.endsWith(".pdf") || type === "application/pdf";
}

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const pasteHintTimer = useRef<number | null>(null);
  const objectUrlsRef = useRef<string[]>([]);

  const hasPdf = useMemo(() => rows.some((r) => r.sourceType === "pdf"), [rows]);

  const fetchPageContent = useCallback(async (url: string) => {
    try {
      const res = await fetch("/api/fetch-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) return "无法获取正文";
      const data = (await res.json()) as { content?: string };
      return (data.content ?? "").trim() || "无法获取正文";
    } catch {
      return "无法获取正文";
    }
  }, []);

  const resolveContentsInPlace = useCallback(
    async (baseRows: Row[]) => {
      // 新手友好：逐条获取正文摘要，便于展示进度
      const next = [...baseRows];
      for (let i = 0; i < next.length; i++) {
        const r = next[i];
        if (!isProbablyUrl(r.text)) continue;
        setStatus(`正在获取链接正文...（${i + 1}/${next.length}）`);
        const content = await fetchPageContent(r.text);
        next[i] = { ...r, content };
        setRows([...next]);
      }
      setStatus("");
    },
    [fetchPageContent]
  );

  const clearObjectUrls = useCallback(() => {
    objectUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    objectUrlsRef.current = [];
  }, []);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const accepted = files.filter((f) => isSupportedUploadFile(f));
      if (accepted.length === 0) return;

      setBusy(true);
      setCopied(false);
      setPreview(null);
      clearObjectUrls();
      setRows([]);
      try {
        const baseRows: Row[] = [];

        const appendRows = (incoming: QrParseResult[]) => {
          const mapped = incoming.map((r) => ({
            ...r,
            content: isProbablyUrl(r.text) ? "正在获取正文..." : "（非 URL）",
          }));
          baseRows.push(...mapped);
          setRows([...baseRows]);
        };

        for (const file of accepted) {
          if (isPdfFile(file)) {
            setStatus(`正在读取 PDF：${file.name}`);
            await parsePdfFileQRCodes(file, {
              onProgress: (p) => setStatus(p),
              onPageResults: (rows) => appendRows(rows),
            });
          } else {
            setStatus(`正在解析图片：${file.name}`);
            const r = await parseImageFileQRCodes(file);
            const imagePreviewUrl = URL.createObjectURL(file);
            objectUrlsRef.current.push(imagePreviewUrl);
            const withPreview = r.map((item) => ({ ...item, previewUrl: imagePreviewUrl }));
            appendRows(withPreview);
          }
        }
        await resolveContentsInPlace([...baseRows]);
      } finally {
        setBusy(false);
        setStatus("");
      }
    },
    [clearObjectUrls, resolveContentsInPlace]
  );

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      await handleFiles(acceptedFiles);
    },
    [handleFiles]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: {
      "image/png": [".png"],
      "image/jpeg": [".jpg", ".jpeg"],
      "application/pdf": [".pdf"],
    },
    multiple: true,
    noClick: true,
    noKeyboard: true,
  });

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const clipboard = e.clipboardData;
      const files: File[] = [];
      if (clipboard?.files?.length) {
        files.push(...Array.from(clipboard.files));
      }
      const items = clipboard?.items ?? [];
      for (const item of items) {
        if (item.kind !== "file") continue;
        const f = item.getAsFile();
        if (f) files.push(f);
      }
      const accepted = files.filter((f) => isSupportedUploadFile(f));
      // 去重：避免 files + items 同时拿到同一文件导致重复解析
      const uniq = accepted.filter(
        (f, i, arr) =>
          arr.findIndex((x) => x.name === f.name && x.size === f.size && x.type === f.type) === i
      );
      if (uniq.length === 0) return;
      e.preventDefault();
      void handleFiles(uniq);
      if (pasteHintTimer.current) window.clearTimeout(pasteHintTimer.current);
      pasteHintTimer.current = window.setTimeout(() => setCopied(false), 800);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleFiles]);

  useEffect(() => {
    return () => clearObjectUrls();
  }, [clearObjectUrls]);

  const onCopyAll = useCallback(async () => {
    const lines = rows.map((r) => {
      const left =
        r.sourceType === "pdf"
          ? `${r.pageLabel}`
          : `${String(r.index).padStart(2, "0")}`;
      return `${left}\t${r.text}\t${r.content}`;
    });
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [rows]);

  const onExportCsv = useCallback(() => {
    const header = hasPdf
      ? ["页码及位置", "二维码链接", "正文摘要"]
      : ["序号", "二维码链接", "正文摘要"];
    const body = rows.map((r) => {
      const left = r.sourceType === "pdf" ? r.pageLabel : String(r.index);
      return [left, r.text, r.content].map(csvEscape).join(",");
    });
    const csv = [header.map(csvEscape).join(","), ...body].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "qr-results.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [hasPdf, rows]);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        <header className="mb-8">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white ring-1 ring-zinc-200">
              <Scan className="h-5 w-5 text-zinc-900" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">
                二维码批量识别与解析工具
              </h1>
              <p className="mt-1 text-sm text-zinc-600">
                支持图片 / PDF。可拖拽上传，也支持剪贴板粘贴（Ctrl/⌘ + V）。
              </p>
            </div>
          </div>
        </header>

        <section
          {...getRootProps()}
          className={[
            "rounded-2xl bg-white ring-1 ring-zinc-200",
            "transition",
            isDragActive ? "ring-2 ring-zinc-900" : "",
          ].join(" ")}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col items-center gap-4 px-6 py-10 text-center sm:flex-row sm:justify-between sm:text-left">
            <div className="flex items-center gap-4">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-zinc-50 ring-1 ring-zinc-200">
                {busy ? (
                  <Loader2 className="h-6 w-6 animate-spin text-zinc-700" />
                ) : (
                  <UploadIcon active={isDragActive} />
                )}
              </div>
              <div>
                <div className="text-sm font-medium">
                  {isDragActive
                    ? "松开鼠标开始上传"
                    : "拖拽文件到这里，或点击选择文件"}
                </div>
                <div className="mt-1 text-xs text-zinc-600">
                  支持：PNG / JPG / JPEG / PDF（可多文件）
                </div>
                {status ? (
                  <div className="mt-2 text-xs text-zinc-700">{status}</div>
                ) : null}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={open}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                选择文件
              </button>
              <button
                type="button"
                onClick={() => {
                  setRows([]);
                  setPreview(null);
                  clearObjectUrls();
                }}
                disabled={busy || rows.length === 0}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-medium text-zinc-900 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                清空
              </button>
            </div>
          </div>
        </section>

        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-700">
              共识别到 <span className="font-semibold">{rows.length}</span> 条结果
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onCopyAll}
                disabled={rows.length === 0}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-medium text-zinc-900 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {copied ? (
                  <>
                    <Check className="h-4 w-4" />
                    已复制
                  </>
                ) : (
                  <>
                    <ClipboardCopy className="h-4 w-4" />
                    一键复制
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={onExportCsv}
                disabled={rows.length === 0}
                className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-medium text-zinc-900 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                导出 CSV
              </button>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-zinc-50 text-xs text-zinc-600">
                  <tr className="border-b border-zinc-200">
                    <th className="whitespace-nowrap px-4 py-3 font-medium">
                      {hasPdf ? "页码及位置" : "序号"}
                    </th>
                    <th className="px-4 py-3 font-medium">二维码链接</th>
                    <th className="px-4 py-3 font-medium">正文摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={3}
                        className="px-4 py-10 text-center text-zinc-500"
                      >
                        暂无结果。请上传图片或 PDF 开始识别。
                      </td>
                    </tr>
                  ) : (
                    rows.map((r, i) => (
                      <tr
                        key={`${r.sourceType}-${r.pageLabel}-${i}-${r.text}`}
                        className="border-b border-zinc-100 last:border-0"
                      >
                        <td className="whitespace-nowrap px-4 py-3 text-zinc-700">
                          <div className="flex items-center gap-2">
                            {r.sourceType === "pdf" ? (
                              <FileText className="h-4 w-4 text-zinc-500" />
                            ) : (
                              <ImageIcon className="h-4 w-4 text-zinc-500" />
                            )}
                            <span className="font-medium text-zinc-900">
                              {r.sourceType === "pdf" ? r.pageLabel : r.index}
                            </span>
                            {r.previewUrl ? (
                              <button
                                type="button"
                                title="查看并放大原图/对应 PDF 页"
                                onClick={() =>
                                  setPreview({
                                    url: r.previewUrl!,
                                    label:
                                      r.sourceType === "pdf"
                                        ? `${r.pageLabel} 预览`
                                        : `图片结果 #${r.index} 预览`,
                                  })
                                }
                                className="rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                              >
                                <Expand className="h-4 w-4" />
                              </button>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {isProbablyUrl(r.text) ? (
                            <a
                              href={r.text}
                              target="_blank"
                              rel="noreferrer"
                              className="break-all text-zinc-900 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-500"
                            >
                              {r.text}
                            </a>
                          ) : (
                            <span className="break-all text-zinc-900">
                              {r.text}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-zinc-700">
                          {r.content === "正在获取正文..." ? (
                            <span className="inline-flex items-center gap-2">
                              <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
                              正在获取正文...
                            </span>
                          ) : (
                            <span className="break-words">{r.content}</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer className="mt-10 text-xs text-zinc-500">
          小提示：PDF 可能包含多个二维码，本工具会尝试逐个识别，并用“页码-第N个/位置”标记。
        </footer>
      </div>

      {preview ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="relative max-h-[92vh] w-full max-w-6xl overflow-hidden rounded-2xl bg-zinc-950">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 text-white">
              <div className="text-sm">{preview.label}</div>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded-md p-1 text-zinc-300 hover:bg-white/10 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(92vh-52px)] overflow-auto p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview.url}
                alt={preview.label}
                className="mx-auto h-auto max-h-[calc(92vh-84px)] w-auto rounded-lg"
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UploadIcon({ active }: { active: boolean }) {
  if (active) {
    return <Scan className="h-6 w-6 text-zinc-900" />;
  }
  return <Scan className="h-6 w-6 text-zinc-700" />;
}
