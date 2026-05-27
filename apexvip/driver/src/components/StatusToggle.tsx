interface StatusToggleProps {
  isAvailable: boolean;
  onToggle: (val: boolean) => void;
}

export default function StatusToggle({ isAvailable, onToggle }: StatusToggleProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: '24px 0',
      }}
    >
      <button
        onClick={() => onToggle(!isAvailable)}
        style={{
          width: 160,
          height: 160,
          borderRadius: '50%',
          border: `3px solid ${isAvailable ? '#22c55e' : '#444444'}`,
          background: isAvailable
            ? 'radial-gradient(circle, rgba(34,197,94,0.15) 0%, rgba(34,197,94,0.05) 70%)'
            : 'radial-gradient(circle, rgba(68,68,68,0.3) 0%, rgba(26,26,26,0.5) 70%)',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          transition: 'all 0.3s ease',
          boxShadow: isAvailable
            ? '0 0 40px rgba(34,197,94,0.2), 0 0 80px rgba(34,197,94,0.1)'
            : '0 0 20px rgba(0,0,0,0.4)',
          position: 'relative',
          outline: 'none',
        }}
      >
        {isAvailable && (
          <span
            style={{
              position: 'absolute',
              inset: -6,
              borderRadius: '50%',
              border: '2px solid rgba(34,197,94,0.3)',
              animation: 'ping 2s cubic-bezier(0,0,0.2,1) infinite',
            }}
          />
        )}
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: '0.12em',
            color: isAvailable ? '#22c55e' : '#555555',
            transition: 'color 0.3s',
          }}
        >
          {isAvailable ? 'AVAILABLE' : 'OFFLINE'}
        </span>
        <span
          style={{
            width: 48,
            height: 48,
            borderRadius: '50%',
            background: isAvailable ? '#22c55e' : '#333333',
            transition: 'background 0.3s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: isAvailable ? '#ffffff' : '#555555',
            }}
          />
        </span>
        <span
          style={{
            fontSize: 11,
            color: isAvailable ? 'rgba(34,197,94,0.7)' : '#444444',
            fontWeight: 500,
          }}
        >
          TAP TO {isAvailable ? 'GO OFFLINE' : 'GO ONLINE'}
        </span>
      </button>

      <style>{`
        @keyframes ping {
          0% { transform: scale(1); opacity: 0.6; }
          75%, 100% { transform: scale(1.3); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
