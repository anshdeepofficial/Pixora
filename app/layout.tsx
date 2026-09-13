import type { Metadata } from "next";
import { Geist, Manrope } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import "./modes.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const image = `${protocol}://${host}/og.png`;
  return {
    title: "Pixora — AI Photo Editor",
    description: "Transform any photo with a simple prompt using V-Editor AI.",
    icons: { icon: "/favicon.svg" },
    openGraph: { title: "Pixora — AI Photo Editor", description: "Edit any photo. Just describe it.", images: [{ url: image, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title: "Pixora — AI Photo Editor", description: "Edit any photo. Just describe it.", images: [image] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geist.variable} ${manrope.variable}`}>{children}</body></html>;
}
