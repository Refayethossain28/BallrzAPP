import type { ReactNode } from 'react';
import Sidebar from './Sidebar';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', width: '100%' }}>
      <Sidebar />
      <main style={{
        flex: 1,
        marginLeft: 240,
        minHeight: '100vh',
        background: '#0f0f0f',
        padding: '32px 32px',
        overflowX: 'hidden',
      }}>
        {children}
      </main>
    </div>
  );
}
