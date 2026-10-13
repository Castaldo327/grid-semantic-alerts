// Shared by the app frame and the form: the signed-in account, and Tabler-style icons (MIT), the set
// Grid Status uses.

export const EMAIL = "chrisjamescastaldo@gmail.com";

/** A 24-unit outline icon drawn from path data. */
export function Icon({ d, size = 24, stroke = 2 }: { d: string[]; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}
