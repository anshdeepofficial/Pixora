import type { Metadata } from "next";
import "./admin.css";

export const metadata: Metadata = {
  title: "Pixora Control",
  robots: { index: false, follow: false, nocache: true },
  icons: {
    icon: [{ url: "/p-control-7f3a9c/icon.svg?v=4", type: "image/svg+xml" }],
    shortcut: [{ url: "/p-control-7f3a9c/icon.svg?v=4", type: "image/svg+xml" }],
  },
};

export default function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
