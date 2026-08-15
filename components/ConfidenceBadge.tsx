interface ConfidenceBadgeProps {
  score: number; // 0 - 100
}

export default function ConfidenceBadge({ score }: ConfidenceBadgeProps) {
  let badgeColor = "bg-red-50 text-red-700 border-red-200";
  if (score >= 85) {
    badgeColor = "bg-green-50 text-green-700 border-green-200";
  } else if (score >= 60) {
    badgeColor = "bg-amber-50 text-amber-700 border-amber-200";
  }

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold border ${badgeColor}`}
    >
      {score}%
    </span>
  );
}
