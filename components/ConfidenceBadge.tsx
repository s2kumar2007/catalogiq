// ConfidenceBadge component — displays a confidence score (0–1) as a colored pill.
// TODO: implement color thresholds and animated fill

interface ConfidenceBadgeProps {
  score?: number; // 0.0 – 1.0
  label?: string;
}

export default function ConfidenceBadge({ score = 0, label }: ConfidenceBadgeProps) {
  return (
    <span className="inline-block rounded-full px-3 py-1 text-xs font-medium bg-gray-100 text-gray-700">
      {label ?? `${Math.round(score * 100)}%`}
    </span>
  );
}
