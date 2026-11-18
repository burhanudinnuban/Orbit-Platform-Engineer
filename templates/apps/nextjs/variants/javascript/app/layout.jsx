import './globals.css';

export const metadata = {
  title: '{{APP_NAME}}',
  description: 'Created by Orbit from the nextjs template',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
