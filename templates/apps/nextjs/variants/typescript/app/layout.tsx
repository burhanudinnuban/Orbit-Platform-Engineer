import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '{{APP_NAME}}',
  description: 'Created by Orbit from the nextjs template',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
