

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
  title: "Panda Share ",
  description: "Zero Knowledge sharing platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${fontSans.variable} ${fontMono.variable} antialiased font-serif`}>
        {children}
      </body>
    </html>
  );
}