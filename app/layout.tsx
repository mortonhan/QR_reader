import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "二维码批量识别与解析工具",
  description: "支持图片与 PDF 的二维码批量识别、标题抓取与导出。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
