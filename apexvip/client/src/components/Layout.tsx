import React from 'react';
import BottomNav from './BottomNav';

interface LayoutProps {
  children: React.ReactNode;
  noPadding?: boolean;
}

export default function Layout({ children, noPadding = false }: LayoutProps) {
  return (
    <div
      style={{
        maxWidth: 480,
        margin: '0 auto',
        minHeight: '100vh',
        background: '#0a0a0a',
        position: 'relative',
        paddingBottom: noPadding ? 0 : 80,
      }}
    >
      {children}
      <BottomNav />
    </div>
  );
}
