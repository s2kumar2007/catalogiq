export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <path
        d="M7 22 L14 10 L25 16"
        stroke="#2DD4BF"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="7" cy="22" r="3.2" fill="#0A0C10" stroke="#2DD4BF" strokeWidth="2" />
      <circle cx="14" cy="10" r="3.2" fill="#2DD4BF" />
      <circle cx="25" cy="16" r="3.2" fill="#0A0C10" stroke="#2DD4BF" strokeWidth="2" />
    </svg>
  );
}
