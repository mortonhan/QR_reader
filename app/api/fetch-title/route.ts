import { NextResponse } from "next/server";
import * as cheerio from "cheerio";

export const runtime = "nodejs";

type Body = {
  url?: string;
};

function normalizeText(input: string | undefined | null) {
  return (input ?? "").replaceAll(/\s+/g, " ").trim();
}

function pickMainContent($: cheerio.CheerioAPI) {
  // 移除无关节点，降低噪音
  $("script, style, noscript, svg, iframe, footer, nav, aside").remove();

  const candidates: string[] = [];
  const add = (v: string) => {
    const t = normalizeText(v);
    if (!t) return;
    candidates.push(t);
  };

  // 优先取语义化正文节点
  add($("article h1").first().text());
  add($("article h2").first().text());
  add($("article p").first().text());
  add($("main h1").first().text());
  add($("main p").first().text());
  add($("h1").first().text());

  // 兼容你给的示例：正文在 <b> 里
  add($("body b").first().text());
  add($("body strong").first().text());

  // 兜底：取 body 的第一段可读文本
  const bodyText = normalizeText($("body").text());
  if (bodyText) {
    const firstSentence = bodyText.split(/[。！？\n]/).find((s) => s.trim().length > 0) ?? "";
    add(firstSentence);
  }

  const best = candidates.find((c) => c.length >= 4) ?? candidates[0];
  if (!best) return "无法获取正文";
  return best.length > 120 ? `${best.slice(0, 120)}...` : best;
}

export async function POST(req: Request) {
  let body: Body | undefined;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ content: "无法获取正文" }, { status: 400 });
  }

  const rawUrl = (body?.url ?? "").trim();
  if (!rawUrl) {
    return NextResponse.json({ content: "无法获取正文" }, { status: 400 });
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return NextResponse.json({ content: "无法获取正文" }, { status: 400 });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return NextResponse.json({ content: "无法获取正文" }, { status: 400 });
  }

  const controller = new AbortController();
  const timeoutMs = 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // 一些站点会拒绝无 UA 的请求
        "user-agent":
          "Mozilla/5.0 (compatible; QRReader/1.0; +https://example.local)",
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (!res.ok) {
      return NextResponse.json({ content: "无法获取正文" }, { status: 200 });
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const content = pickMainContent($);
    return NextResponse.json({ content }, { status: 200 });
  } catch {
    return NextResponse.json({ content: "无法获取正文" }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}

