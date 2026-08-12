import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "../lib/i18n";

export const metadata: Metadata = {
  title: "After-Sales Assistant · 售后客服助手 | EdgeOne Makers",
  description: "AI-powered after-sales customer service assistant · Demo only · EdgeOne Makers",
  keywords: "EdgeOne Makers, Demo only",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // <html lang> defaults to "en"; client-side I18nProvider updates it after
  // mount if the user has chosen a different locale.
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
