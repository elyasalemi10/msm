import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RefreshBar } from "@/components/layout/refresh-bar";
import "./globals.css";

const geist = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "StrataWise",
  description: "Professional strata management platform for Australian property managers",
  icons: {
    icon: [
      { url: "/stratawise-favicon.webp", type: "image/webp" },
      { url: "/stratawise-favicon.png", type: "image/png" },
    ],
    apple: "/stratawise-favicon.webp",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geist.variable} font-sans antialiased`}>
        <RefreshBar />
        <TooltipProvider>
          {children}
        </TooltipProvider>
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
