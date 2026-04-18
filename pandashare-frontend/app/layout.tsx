

import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Metadata } from "next";

const fontSans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});


const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "PandaShare — Secure File Sharing",
  description: "Zero-knowledge, room-based file sharing with end-to-end encryption. Share files of any size with client-side AES-256-GCM encryption.",
  openGraph: {
    title: "PandaShare — Secure File Sharing",
    description: "Zero-knowledge, room-based file sharing with end-to-end encryption.",
    type: "website",
  },
};

import { Toaster } from "sonner";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${fontSans.variable} ${fontMono.variable} antialiased font-mono`}>
        {children}
        <Toaster theme="dark" position="bottom-right" closeButton richColors />
      </body>
    </html>
  );
}