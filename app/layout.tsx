import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Messenger Server",
  description: "Messenger account and incremental synchronization service",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
