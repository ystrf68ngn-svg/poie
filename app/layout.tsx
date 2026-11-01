import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "poie · AI 群聊",
  description: "一个人，也能拥有一支团队。让不同智能体一起思考，由你决定方向。",
  icons: { icon: "/favicon.png?v=0.5.0", shortcut: "/favicon.png?v=0.5.0" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><head><meta httpEquiv="Content-Security-Policy" content="frame-src about:" /></head><body>{children}</body></html>;
}
