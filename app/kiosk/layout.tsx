import type { ReactNode } from "react";

export const metadata = {
  title: "Gansevoort Kiosk",
  description: "Employee inventory withdrawal kiosk",
};

export default function KioskLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-screen w-full">{children}</div>;
}
