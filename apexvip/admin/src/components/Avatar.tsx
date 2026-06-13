interface Props {
  name: string;
  size?: number;
  fontSize?: number;
}

function getInitials(name: string) {
  return name
    .split(' ')
    .slice(0, 2)
    .map((n) => n[0])
    .join('')
    .toUpperCase();
}

function getColor(name: string) {
  const colors = [
    '#C9A84C', '#3b82f6', '#22c55e', '#a855f7',
    '#f59e0b', '#06b6d4', '#ef4444', '#8b5cf6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

export default function Avatar({ name, size = 36, fontSize }: Props) {
  const bg = getColor(name);
  const fs = fontSize ?? Math.round(size * 0.38);
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: bg + '33',
      border: `1.5px solid ${bg}55`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: fs,
      fontWeight: 700,
      color: bg,
      flexShrink: 0,
      letterSpacing: '0.02em',
    }}>
      {getInitials(name)}
    </div>
  );
}
