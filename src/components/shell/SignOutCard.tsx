'use client';

import { SignOutButton } from '@clerk/nextjs';

/** Pending / suspended account screen, built from the legacy sign-in primitives (#login, .lbox, .lerr). */
export function SignOutCard({ title, message }: { title: string; message: string }) {
  return (
    <div id="login" className="on">
      <div className="lbox">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/assets/logo.png" alt="ISFC" />
        <h1>{title}</h1>
        <p className="co">International Specialized Food Co.</p>
        <div className="lerr" style={{ marginTop: 16 }}>
          {message}
        </div>
        <SignOutButton redirectUrl="/sign-in">
          <button className="btn o" style={{ marginTop: 16 }}>
            Sign out
          </button>
        </SignOutButton>
      </div>
    </div>
  );
}
