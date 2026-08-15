// GapAskCard component — surfaces a missing field and lets the user supply it.
// TODO: wire up submission to /api/gap-resolve

interface GapAskCardProps {
  fieldName?: string;
  question?: string;
  onAnswer?: (value: string) => void;
}

export default function GapAskCard({
  fieldName = "unknown_field",
  question = "Can you provide this information?",
  onAnswer,
}: GapAskCardProps) {
  return (
    <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-4">
      <p className="text-sm font-semibold text-yellow-800 mb-1">Missing: {fieldName}</p>
      <p className="text-sm text-yellow-700 mb-3">{question}</p>
      <input
        type="text"
        placeholder="Your answer…"
        className="w-full rounded-md border border-yellow-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-400"
        onKeyDown={(e) => {
          if (e.key === "Enter") onAnswer?.((e.target as HTMLInputElement).value);
        }}
      />
      {/* TODO: submit button, loading state */}
    </div>
  );
}
