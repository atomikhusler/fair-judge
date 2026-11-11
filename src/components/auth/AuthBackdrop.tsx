import React, { memo } from 'react';

interface AuthBackdropProps {
  role: 'organiser' | 'judge';
}

export const AuthBackdrop = memo(function AuthBackdrop({ role }: AuthBackdropProps) {
  const accentColor = role === 'judge' ? 'rgb(245 158 11)' : 'rgb(16 185 129)';

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none z-0 overflow-hidden fj-auth-backdrop"
    >
      {/* Glow: radial-gradient(ellipse 60% 40% at 50% 0%, <accent>, transparent 70%) */}
      <div
        className="absolute inset-0 opacity-[0.10] dark:opacity-[0.16]"
        style={{
          background: `radial-gradient(ellipse 60% 40% at 50% 0%, ${accentColor}, transparent 70%)`,
        }}
      />
      {/* Dot grid: radial-gradient(circle at 1px 1px, rgba(zinc-500,0.18) 1px, transparent 0) 22px 22px */}
      <div
        className="absolute inset-0 opacity-[0.14] dark:opacity-[0.18]"
        style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, rgb(113 113 122) 1px, transparent 0)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(ellipse at 50% 30%, #000 20%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 30%, #000 20%, transparent 75%)',
        }}
      />
    </div>
  );
});
